import { Router } from '../lib/router';
import multer from 'multer';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { bucket, invalidateSignedUrlCache, uploadFileToStorage } from '../lib/firebaseAdmin';
import {
  createProject,
  deleteStoredProject,
  getStoredProject,
  listStoredProjects,
  projectLanguages,
  segmentsForLanguage,
  toClientProject,
  updateStoredProject,
  getSettings,
  type StoredLanguageOutput,
  type StoredProject,
} from '../lib/projectRepo';
import { extractAudioForStt, extractThumbnail, probeMedia } from '../lib/ffmpeg';
import { validateMedia } from '../lib/mediaValidation';
import { assertSafeDownloadUrl, streamToFile } from '../lib/safeDownload';
import { refuseWhenDraining } from '../lib/lifecycle';
import { rateLimit } from '../lib/rateLimit';
import { limits, rateRules } from '../lib/limits';
import { acquireHeavySlot } from '../lib/heavyWork';
import { routeTranscribe, routeTranslateSegments } from '../lib/modelRouter';
import { alignSegmentsToSpeech, detectSpeechRegions, retimeWords } from '../lib/forcedAlign';
import { isCtcAlignAvailable, refineTimingsWithCtc, warmCtcModel } from '../lib/ctcAlign';
import { describeTranscriptHealth, sanitizeTranscript } from '../lib/transcriptSanitizer';
import { costEstimate, createCostMeter, recordStt, summarizeCost } from '../lib/costMeter';
import { getLanguageName, mapDetectedLanguageToAppCode, resolveTargetLanguages } from '../lib/languageMeta';
import { mapWithConcurrency } from '../lib/concurrency';
import { tmpDir } from '../lib/paths';
import { HttpError } from '../lib/httpError';
import { requireAdmin } from '../lib/auth';
import { SAMPLE_VIDEOS, VOICES } from '../../src/data/mockData';
import type { LocalizedSegment, SpeakerProfile, TranscriptSegment } from '../../src/types';
import { castVoices, profilesForSpeakers } from '../lib/speakerProfiles';
import { acceptHeardPerformance } from '../lib/performance';
import { log } from '../lib/log';
import {
  JobCancelledError,
  JobConflictError,
  JobSupersededError,
  jobDirFor,
  markRunningHere,
  recordJobUsage,
  requestCancel,
  settleJob,
  startHeartbeat,
  startTranscribeJob,
  writeProjectForJob,
  type DubJob,
} from '../lib/jobs';
import { trackBackgroundWork } from '../lib/lifecycle';
import { withLogContext } from '../lib/log';
import { deleteSharesForProject } from './share';
import { assertStorageAvailable, invalidateStorageUsage } from '../lib/storageUsage';
import { schemas, validateBody } from '../lib/validation';
import { getGlossary } from '../lib/glossaryStore';
import { reconcileSavedSegments, textQaFlags, withFlags } from '../lib/lineReview';
import { withRetakeInfo } from '../lib/retake';

/**
 * Derives speaker count and per-speaker voice assignments from labels the transcription
 * step already returned.
 *
 * This deliberately does no extra model call. Speaker labels used to come from a separate
 * diarization pass that re-uploaded the whole audio to Gemini, which roughly doubled the
 * (audio-token priced) cost of analyzing a video. The transcription prompt now returns
 * the labels itself, so multi-speaker detection is effectively free.
 */
function resolveSpeakers(
  segments: TranscriptSegment[],
  heard: Record<string, SpeakerProfile>,
  preferredVoiceId: string
): {
  segments: TranscriptSegment[];
  speakersCount: number;
  speakerVoiceMap: Record<string, string>;
  speakerProfiles: Record<string, SpeakerProfile>;
} {
  if (segments.length === 0) {
    return { segments, speakersCount: 1, speakerVoiceMap: {}, speakerProfiles: {} };
  }
  const distinct = Array.from(new Set(segments.map((s) => s.speaker || 'Speaker 1'))).sort();
  const speakerProfiles = profilesForSpeakers(heard, distinct);
  return {
    segments,
    speakersCount: distinct.length,
    // Cast by who is actually talking: a voice of the speaker's own gender, distinct per speaker.
    speakerVoiceMap: distinct.length > 1 ? castVoices(distinct, speakerProfiles, VOICES, preferredVoiceId) : {},
    speakerProfiles,
  };
}

export const projectsRouter = Router();

const uploadDir = path.join(tmpDir, 'uploads');
// The one size boundary for source video, whether uploaded or fetched as a sample.
export const MAX_SOURCE_VIDEO_BYTES = 500 * 1024 * 1024;
const SAMPLE_DOWNLOAD_TIMEOUT_MS = 2 * 60 * 1000;
// Hosts the built-in samples are served from; the server fetches nothing else.
const SAMPLE_HOSTS = Array.from(new Set(SAMPLE_VIDEOS.map((s) => new URL(s.videoUrl).hostname.toLowerCase())));

const upload = multer({
  storage: multer.diskStorage({
    destination: async (_req, _file, cb) => {
      try {
        await mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      } catch (err) {
        cb(err as Error, uploadDir);
      }
    },
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname)}`),
  }),
  limits: { fileSize: MAX_SOURCE_VIDEO_BYTES },
  fileFilter: (_req, file, cb) => {
    if (!/^video\//.test(file.mimetype) && !/\.(mp4|mov|webm)$/i.test(file.originalname)) {
      cb(new HttpError(400, 'UNSUPPORTED_FILE', 'Only video files (mp4/mov/webm) are accepted'));
      return;
    }
    cb(null, true);
  },
});

// Scoped by workspace: any member can open any of the workspace's projects.
async function requireProject(workspaceId: string, id: string) {
  return getStoredProject(workspaceId, id);
}

projectsRouter.post('/', validateBody(schemas.createProject), async (req, res) => {
  const { title, sourceLanguage, targetLanguage } = req.body || {};
  const project = await createProject(req.workspaceId!, req.uid!, {
    title: title || 'Untitled Dub',
    sourceLanguage,
    targetLanguage,
  });
  res.status(201).json(await toClientProject(project));
});

projectsRouter.get('/', async (req, res) => {
  const projects = await listStoredProjects(req.workspaceId!);
  res.json(await Promise.all(projects.map(toClientProject)));
});

projectsRouter.get('/:id', async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });
  res.json(withRetakeInfo(await toClientProject(stored), stored));
});

const PATCHABLE_FIELDS = [
  'title',
  'targetLanguage',
  'selectedVoiceId',
  'speakerVoiceMap',
  'languageVoiceMap',
  'languageSpeakerVoiceMap',
  'translationStyle',
  'adaptExpressions',
  'autoLipSync',
  'voiceSpeed',
  'voicePitch',
  'voiceEmotion',
  'transcriptSegments',
  'localizedSegments',
  'currentStep',
] as const;

projectsRouter.patch('/:id', validateBody(schemas.patchProject), async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const patch: Record<string, unknown> = {};
  for (const field of PATCHABLE_FIELDS) {
    if (field in (req.body || {})) patch[field] = req.body[field];
  }
  // The top-level lines are the primary language's; they get the same server-side review as a per-language save.
  if (Array.isArray(patch.localizedSegments)) {
    patch.localizedSegments = reconcileSavedSegments(patch.localizedSegments as LocalizedSegment[], segmentsForLanguage(stored, stored.targetLanguage), {
      languageCode: stored.targetLanguage,
      sourceLanguageCode: stored.sourceLanguage,
      glossary: await getGlossary(req.workspaceId!),
    });
  }
  const updated = await updateStoredProject(req.workspaceId!, req.params.id, patch);
  res.json(withRetakeInfo(await toClientProject(updated), updated));
});

// Deleting is the one project action editors cannot take.
projectsRouter.delete('/:id', requireAdmin, async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  // Deletes the project's whole storage folder, but only logs referenced paths outside it (they may belong to another workspace's copy).
  const ownPrefix = `workspaces/${req.workspaceId}/projects/${req.params.id}/`;
  const referenced = [
    stored.videoStoragePath,
    stored.dubbedAudioStoragePath,
    stored.finalDubbedVideoStoragePath,
    stored.videoThumbnailStoragePath,
    ...Object.values(stored.languageOutputs || {}).flatMap((out) => [out.dubbedAudioStoragePath, out.finalDubbedVideoStoragePath]),
  ].filter((p): p is string => Boolean(p));
  const foreign = referenced.filter((p) => !p.startsWith(ownPrefix));
  if (foreign.length) log.warn('retained_shared_objects', { projectId: req.params.id, paths: foreign });

  await bucket.deleteFiles({ prefix: ownPrefix, force: true });
  referenced.forEach(invalidateSignedUrlCache);
  await deleteSharesForProject(req.params.id);
  await deleteStoredProject(req.workspaceId!, req.params.id);
  invalidateStorageUsage(req.workspaceId!);
  res.status(204).send();
});

async function ingestSourceVideo(workspaceId: string, projectId: string, localVideoPath: string, fileName: string, fileSizeBytes: number) {
  // Judged by content, not by the uploaded name or MIME type; see server/lib/mediaValidation.ts.
  const probe = await validateMedia(localVideoPath, 'video');
  if (probe.durationSeconds > limits.maxVideoSeconds) {
    throw new HttpError(
      400,
      'VIDEO_TOO_LONG',
      `Videos can be up to ${Math.round(limits.maxVideoSeconds / 60)} minutes long; this one is ${Math.ceil(probe.durationSeconds / 60)} minutes.`
    );
  }
  const storagePath = `workspaces/${workspaceId}/projects/${projectId}/source${probe.ext}`;
  await uploadFileToStorage(storagePath, localVideoPath, probe.contentType);

  const resolution = probe.width && probe.height ? `${probe.width} × ${probe.height} (${probe.height >= 1080 ? 'Full HD' : probe.height >= 720 ? 'HD' : 'SD'})` : 'Unknown';
  const sizeMb = fileSizeBytes / (1024 * 1024);

  let videoThumbnailStoragePath: string | undefined;
  if (probe.width && probe.height) {
    try {
      const thumbLocalPath = path.join(path.dirname(localVideoPath), `${randomUUID()}.jpg`);
      await extractThumbnail(localVideoPath, thumbLocalPath, probe.durationSeconds * 0.1, probe.durationSeconds);
      const thumbStoragePath = `workspaces/${workspaceId}/projects/${projectId}/thumbnail.jpg`;
      await uploadFileToStorage(thumbStoragePath, thumbLocalPath, 'image/jpeg');
      videoThumbnailStoragePath = thumbStoragePath;
      await rm(thumbLocalPath, { force: true });
    } catch {
      // Thumbnail is cosmetic — fall back to the placeholder icon rather than failing the upload.
    }
  }

  invalidateStorageUsage(workspaceId);
  return updateStoredProject(workspaceId, projectId, {
    videoStoragePath: storagePath,
    videoThumbnailStoragePath,
    videoFileName: fileName,
    videoDuration: probe.durationSeconds,
    videoResolution: resolution,
    videoFileSize: `${sizeMb.toFixed(1)} MB`,
    status: 'draft',
  });
}

projectsRouter.post('/:id/upload', refuseWhenDraining, rateLimit('upload', [['user', rateRules.uploadPerUser]]), upload.single('file'), async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

  try {
    await assertStorageAvailable(req.workspaceId!, req.file.size);
    const updated = await ingestSourceVideo(req.workspaceId!, req.params.id, req.file.path, req.file.originalname, req.file.size);
    res.json(await toClientProject(updated));
  } finally {
    await rm(req.file.path, { force: true });
  }
});

// Loads a built-in sample by id (the URL comes from the server list); an old client may send the exact sample URL instead.
projectsRouter.post('/:id/import-sample', refuseWhenDraining, rateLimit('import-sample', [['user', rateRules.importSamplePerUser]]), validateBody(schemas.importSample), async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const { sampleId, sourceUrl } = req.body || {};
  const sample = SAMPLE_VIDEOS.find((s) => (typeof sampleId === 'string' && s.id === sampleId) || (typeof sourceUrl === 'string' && s.videoUrl === sourceUrl));
  if (!sample) return res.status(400).json({ error: 'Unknown sample video', code: 'UNKNOWN_SAMPLE' });

  const localPath = path.join(uploadDir, `${randomUUID()}.mp4`);
  try {
    const url = await assertSafeDownloadUrl(sample.videoUrl, SAMPLE_HOSTS);
    const { bytes } = await streamToFile(url, localPath, { maxBytes: MAX_SOURCE_VIDEO_BYTES, timeoutMs: SAMPLE_DOWNLOAD_TIMEOUT_MS });
    await assertStorageAvailable(req.workspaceId!, bytes);
    const updated = await ingestSourceVideo(req.workspaceId!, req.params.id, localPath, `${sample.title}.mp4`, bytes);
    res.json(await toClientProject(updated));
  } finally {
    await rm(localPath, { force: true });
  }
});

// How long the optional word-timing pass may hold up an analysis before VAD timings are used instead.
const CTC_BASE_BUDGET_MS = 25_000;
const CTC_BUDGET_MS_PER_AUDIO_SECOND = 150;
const CTC_MAX_BUDGET_MS = 75_000;

const transcribeLimit = rateLimit('transcribe', [
  ['user', rateRules.transcribePerUser],
  ['workspace', rateRules.transcribePerWorkspace],
]);

// A transcription may run this long before it is stopped (TRANSCRIBE_TIMEOUT_MINUTES); a 60-minute video normally needs far less.
const TRANSCRIBE_TIMEOUT_MS = (Number(process.env.TRANSCRIBE_TIMEOUT_MINUTES) || 45) * 60 * 1000;
export const ANALYSIS_FAILED_MESSAGE = 'Analysis failed. Please try again.';

export interface TranscriptionOutcome {
  projectPatch: Partial<StoredProject>;
  result: { detectedLanguage: string; removedSegments: number; sanitizeNote: string };
}

// Analyzes the video as a job: `Prefer: respond-async` gets 202 and a job id to poll, otherwise the request waits and answers as before.
projectsRouter.post('/:id/transcribe', refuseWhenDraining, transcribeLimit, async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });
  if (!stored.videoStoragePath) return res.status(400).json({ error: 'Upload a video before analyzing' });

  let job: DubJob;
  try {
    job = await startTranscribeJob({ workspaceId: req.workspaceId!, projectId: req.params.id, userId: req.uid! });
  } catch (err) {
    if (err instanceof JobConflictError) return res.status(409).json({ error: err.message, code: 'JOB_ALREADY_RUNNING', jobId: err.jobId });
    throw err;
  }
  const run = trackBackgroundWork(runTranscribeJob(job, stored));

  if (/respond-async/i.test(req.get('Prefer') || '')) {
    res.setHeader('Preference-Applied', 'respond-async');
    return res.status(202).json({ jobId: job.id, status: 'running' });
  }

  const finished = await run;
  if (finished.status !== 'completed') {
    const status = finished.errorCode === 'CANCELLED' || finished.errorCode === 'TIMEOUT' ? 409 : finished.httpStatus;
    return res.status(status).json({ error: finished.userMessage || ANALYSIS_FAILED_MESSAGE, code: finished.errorCode || 'ANALYSIS_FAILED' });
  }
  const updated = (await getStoredProject(req.workspaceId!, req.params.id))!;
  res.json({ ...(await toClientProject(updated)), ...finished.result });
});

// Runs a transcription job to settlement and resolves (never rejects) with the outcome the synchronous endpoint returns.
function runTranscribeJob(
  job: DubJob,
  stored: StoredProject
): Promise<{ status: string; errorCode?: string; userMessage?: string; httpStatus: number; result?: TranscriptionOutcome['result'] }> {
  return withLogContext({ jobId: job.id, projectId: job.projectId, workspaceId: job.workspaceId, userId: job.userId }, async () => {
    const stopHeartbeat = startHeartbeat(job.id);
    const unmark = markRunningHere(job.id);
    const timeout = setTimeout(() => void requestCancel(job.id, 'timeout'), TRANSCRIBE_TIMEOUT_MS);
    timeout.unref();
    const started = Date.now();
    log.info('job_started', { type: 'transcribe' });
    try {
      const outcome = await transcriptionImpl(job, stored);
      await settleJob(job.id, { status: 'completed', refundMinutes: 0, projectPatch: outcome.projectPatch, result: outcome.result });
      log.info('job_finished', { type: 'transcribe', status: 'completed', durationMs: Date.now() - started });
      return { status: 'completed', httpStatus: 200, result: outcome.result };
    } catch (err) {
      if (err instanceof JobSupersededError) {
        log.warn('job_superseded', { type: 'transcribe', durationMs: Date.now() - started });
        return { status: 'failed', errorCode: 'SUPERSEDED', userMessage: ANALYSIS_FAILED_MESSAGE, httpStatus: 409 };
      }
      const cancelled = err instanceof JobCancelledError;
      const errorCode = cancelled ? (err.reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED') : err instanceof HttpError ? err.code : 'ANALYSIS_FAILED';
      const userMessage = cancelled
        ? err.reason === 'timeout'
          ? 'Analysis took too long and was stopped. Please try again.'
          : 'Analysis was cancelled.'
        : err instanceof HttpError
          ? err.message
          : ANALYSIS_FAILED_MESSAGE;
      if (cancelled) log.warn('job_cancelled', { type: 'transcribe', errorCode, durationMs: Date.now() - started });
      else log.error('job_failed', err, { type: 'transcribe', errorCode, durationMs: Date.now() - started });
      await settleJob(job.id, {
        status: cancelled ? 'cancelled' : 'failed',
        refundMinutes: 0,
        errorCode,
        errorMessage: (err as Error).message,
        userMessage,
        projectPatch: { progressPercent: 0, currentProcessingMessage: '' },
      }).catch((settleErr) => log.error('job_settle_failed', settleErr));
      return { status: cancelled ? 'cancelled' : 'failed', errorCode, userMessage, httpStatus: err instanceof HttpError ? err.status : 500 };
    } finally {
      clearTimeout(timeout);
      stopHeartbeat();
      unmark();
    }
  });
}

// Test seam: lets job tests run, fail or hold a transcription open without media or Vertex.
let transcriptionImpl: (job: DubJob, stored: StoredProject) => Promise<TranscriptionOutcome> = (job, stored) => runTranscriptionPipeline(job, stored);
export function setTranscriptionPipelineForTests(fn: ((job: DubJob, stored: StoredProject) => Promise<TranscriptionOutcome>) | null): void {
  transcriptionImpl = fn ?? ((job, stored) => runTranscriptionPipeline(job, stored));
}

// The analysis itself: download, extract audio, speech-to-text, clean-up, timing alignment, speakers.
async function runTranscriptionPipeline(job: DubJob, stored: StoredProject): Promise<TranscriptionOutcome> {
  const jobDir = jobDirFor(job.id);
  await mkdir(jobDir, { recursive: true });
  const videoLocalPath = path.join(jobDir, 'source.mp4');
  const audioLocalPath = path.join(jobDir, 'audio.wav');
  // Progress reports; a failed write is ignored, but losing the project or a cancel request stops the run here.
  const report = async (progressPercent: number, currentProcessingMessage: string) => {
    try {
      await writeProjectForJob(job, { progressPercent, currentProcessingMessage }, { stage: currentProcessingMessage, progress: progressPercent });
    } catch (err) {
      if (err instanceof JobCancelledError || err instanceof JobSupersededError) throw err;
    }
  };

  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireHeavySlot(() => report(2, 'Waiting for a free processing slot'));
    await report(3, 'Fetching your video');
    // Checked by the route before the job was created.
    await bucket.file(stored.videoStoragePath!).download({ destination: videoLocalPath });
    await report(8, 'Extracting the audio track');
    await extractAudioForStt(videoLocalPath, audioLocalPath);

    const settings = await getSettings(job.userId);
    await report(12, 'Listening to the speech');
    const { language, segments: rawSegments, provider: sttProviderUsed, speakers: heardSpeakers } = await routeTranscribe(
      audioLocalPath,
      stored.targetLanguage,
      settings.sttProvider,
      (done, total, language) => {
        // The first chunk reveals the language, so the word-timing model loads while the remaining chunks are still transcribing.
        if (done === 1) warmCtcModel(mapDetectedLanguageToAppCode(language));
        return report(12 + Math.round((done / total) * 63), total > 1 ? `Listening to the speech — part ${done} of ${total} done` : 'Speech transcribed');
      }
    );
    await report(78, 'Cleaning up the transcript');
    const detectedSourceLanguage = mapDetectedLanguageToAppCode(language);

    // Every STT model loops on non-speech audio, emitting one filler word over and over
    // (measured: 204 of 223 segments were "Okay." on a real interview). Those are stripped
    // before anything downstream sees them — each one would otherwise become a synthesized
    // line in the dub, and would drag the alignment of every real line out of place.
    const { segments: cleanSegments, removed: hallucinated, note: sanitizeNote } =
      sanitizeTranscript(rawSegments);
    console.log(`[transcribe] ${job.projectId}: ${describeTranscriptHealth(rawSegments, cleanSegments)}`);

    const audioSeconds = (await probeMedia(audioLocalPath)).durationSeconds;
    const costMeter = createCostMeter();
    recordStt(costMeter, sttProviderUsed, audioSeconds);
    log.info('job_cost', { type: 'transcribe', ...costEstimate(costMeter) }, `[cost] transcribe ${job.projectId}: ${summarizeCost(costMeter)}`);
    await recordJobUsage(job.id, { ...costEstimate(costMeter) });

    // Gemini gives accurate text but unreliable timing (it estimates and drifts
    // progressively across a long clip). Timing is therefore rebuilt from the audio in
    // two passes, coarse then fine.
    //
    // Pass 1 (always): voice-activity detection finds where speech physically is, and the
    // transcript is partitioned onto those regions. This decides *which* stretch of audio
    // each line belongs to, and never places a line in silence.
    let timedSegments = cleanSegments;
    await report(84, 'Syncing every line to the exact moment it is spoken');
    try {
      const probe = await probeMedia(audioLocalPath);
      const regions = await detectSpeechRegions(audioLocalPath, probe.durationSeconds);
      if (regions.length > 0) {
        // Aligns the sanitized lines; aligning rawSegments put the removed filler loops back and dragged every real line off its speech.
        timedSegments = alignSegmentsToSpeech(cleanSegments, regions).map(retimeWords);
      }
    } catch (err) {
      console.error('[projects] speech alignment failed, keeping provider timings', err);
    }

    // Pass 2 (when the model is installed): a CTC forced alignment solves for the exact
    // frame each word lands on, turning pass 1's region-level estimate into measured
    // word-level timing. Best-effort — a failure here leaves pass 1's timings standing,
    // which is what every project got before this existed.
    if (isCtcAlignAvailable(detectedSourceLanguage)) {
      await report(90, 'Measuring word-by-word timing');
      try {
        // Word timing is a refinement: past its budget the VAD timings stand, rather than holding the user on this screen.
        const budgetMs = Math.min(CTC_MAX_BUDGET_MS, CTC_BASE_BUDGET_MS + audioSeconds * CTC_BUDGET_MS_PER_AUDIO_SECOND);
        const refined = await Promise.race([
          refineTimingsWithCtc(audioLocalPath, detectedSourceLanguage, timedSegments),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), budgetMs)),
        ]);
        if (refined) timedSegments = refined;
        else console.warn(`[projects] word timing exceeded its ${Math.round(budgetMs / 1000)}s budget, keeping VAD timings`);
      } catch (err) {
        console.error('[projects] forced alignment failed, keeping VAD timings', err);
      }
    }

    await report(97, 'Identifying speakers');
    const { segments, speakersCount, speakerVoiceMap, speakerProfiles } = resolveSpeakers(timedSegments, heardSpeakers, stored.selectedVoiceId);

    const wordsCount = segments.reduce((sum, s) => sum + s.wordsCount, 0);
    return {
      projectPatch: {
        transcriptSegments: segments,
        sourceLanguage: detectedSourceLanguage,
        wordsCount,
        speakersCount,
        speakerVoiceMap,
        speakerProfiles,
        currentStep: 'understand',
        progressPercent: 0,
        currentProcessingMessage: '',
      },
      // Surfaced so the UI can say what happened rather than silently showing fewer lines than the model returned.
      result: { detectedLanguage: getLanguageName(detectedSourceLanguage), removedSegments: hallucinated, sanitizeNote },
    };
  } finally {
    releaseSlot?.();
    await rm(jobDir, { recursive: true, force: true });
  }
}

/**
 * Languages translated at once. The calls are independent, so running them together keeps
 * a five-language project roughly as fast as a one-language one — but not *all* at once,
 * because the providers rate-limit per project and a burst of ten just trips that.
 */
const TRANSLATE_CONCURRENCY = 3;

const translateLimit = rateLimit('translate', [
  ['user', rateRules.translatePerUser],
  ['workspace', rateRules.translatePerWorkspace],
]);

projectsRouter.post('/:id/translate', translateLimit, validateBody(schemas.translate), async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const { style, adaptExpressions } = req.body || {};
  const finalStyle = style || stored.translationStyle;
  const finalAdapt = adaptExpressions ?? stored.adaptExpressions;

  const resolved = resolveTargetLanguages(req.body || {}, stored.targetLanguage);
  if ('error' in resolved) return res.status(400).json({ error: resolved.error });
  const targets = resolved.languages;

  if (!stored.transcriptSegments?.length) {
    return res.status(400).json({ error: 'Analyze the video before translating' });
  }

  try {
    const [settings, glossary] = await Promise.all([getSettings(req.uid!), getGlossary(req.workspaceId!)]);
    // Some STT chunks (e.g. a silent lead-in) come back with empty text — sending those
    // to translation is meaningless. Skip them; they map to an empty translation.
    const translatable = stored.transcriptSegments.filter((s) => s.text.trim().length > 0);
    const sourceLines = translatable.map((s) => ({
      id: s.id,
      // The tagged version carries the laughs and sighs through translation; it only counts while it still matches the (editable) text.
      text: acceptHeardPerformance(s.text, s.performance) ?? s.text,
      speaker: s.speaker,
      // The slot this line has to fit into, so the translation is written to be
      // speakable in that time instead of needing to be sped up afterwards.
      durationSeconds: Math.max(0.5, s.endTime - s.startTime),
    }));

    // Adding a sixth language to a project shouldn't re-buy the five translations that
    // already exist — so a language that is already translated is reused unless the user
    // explicitly asked to regenerate, or the style/adaptation settings changed under it.
    const settingsChanged = finalStyle !== stored.translationStyle || finalAdapt !== stored.adaptExpressions;
    const regenerate = Boolean(req.body?.regenerate) || settingsChanged;

    const perLanguage = await mapWithConcurrency(targets, TRANSLATE_CONCURRENCY, async (languageCode) => {
      const existing = segmentsForLanguage(stored, languageCode);
      if (!regenerate && existing.length > 0) return { languageCode, segments: existing };

      const { translations } =
        sourceLines.length > 0
          ? await routeTranslateSegments(sourceLines, languageCode, finalStyle, finalAdapt, settings.translateProvider, glossary, {
              speakers: stored.speakerProfiles,
            })
          : { translations: {} as Record<string, string> };

      const review = { languageCode, sourceLanguageCode: stored.sourceLanguage, glossary };
      const segments: LocalizedSegment[] = stored.transcriptSegments.map((seg) => {
        const line: LocalizedSegment = {
          id: `loc-${languageCode}-${seg.id}`,
          segmentId: seg.id,
          startTime: seg.startTime,
          endTime: seg.endTime,
          speaker: seg.speaker,
          sourceText: seg.text,
          translatedText: translations[seg.id] || seg.text,
          isEdited: false,
          // The original's delivery carries over, so the dubbed voice performs the line the same way.
          ...(seg.delivery ? { delivery: seg.delivery } : {}),
        };
        return withFlags(line, textQaFlags(line, review));
      });
      return { languageCode, segments };
    });

    // The first requested language is the primary one: it keeps the top-level fields, so
    // the workspace, the caption burner and any older client keep reading a project the
    // same way they always have.
    const primary = perLanguage[0];
    const languageOutputs: Record<string, StoredLanguageOutput> = {};
    for (const { languageCode, segments } of perLanguage) {
      languageOutputs[languageCode] = {
        // Carry over any render this language already has, so re-translating one language
        // doesn't drop the finished videos of the others.
        ...stored.languageOutputs?.[languageCode],
        languageCode,
        localizedSegments: segments,
        status: 'draft',
        progressPercent: 0,
      };
    }

    // Adding languages to a finished project must never forget the ones already dubbed, or their renders drop out of the project.
    const finishedLanguages = projectLanguages(stored).filter(
      (code) =>
        !targets.includes(code) &&
        (stored.languageOutputs?.[code]?.status === 'completed' ||
          // Projects from before multi-language dubbing only record the primary render at the top level.
          (code === stored.targetLanguage && Boolean(stored.finalDubbedVideoStoragePath)))
    );
    // A primary language that already has a finished dub stays primary, so the project's headline video doesn't change under the user.
    const keepPrimary = finishedLanguages.includes(stored.targetLanguage);
    const primaryCode = keepPrimary ? stored.targetLanguage : primary.languageCode;

    const updated = await updateStoredProject(req.workspaceId!, req.params.id, {
      targetLanguage: primaryCode,
      targetLanguages: keepPrimary
        ? [stored.targetLanguage, ...finishedLanguages.filter((c) => c !== stored.targetLanguage), ...targets]
        : [...targets, ...finishedLanguages],
      languageOutputs,
      translationStyle: finalStyle,
      adaptExpressions: finalAdapt,
      localizedSegments: keepPrimary ? segmentsForLanguage(stored, primaryCode) : primary.segments,
      currentStep: 'localize',
    });
    res.json(withRetakeInfo(await toClientProject(updated), updated));
  } catch (err) {
    log.error('translate_failed', err, { projectId: req.params.id });
    res.status(500).json({ error: (err as Error).message });
  }
});

/**
 * Saves a hand-edited translation for one language.
 *
 * Separate from the generic PATCH because the primary language's segments live at the top
 * level while the rest live inside `languageOutputs` — and `languageOutputs` also holds
 * storage paths, which a client must not be able to overwrite by patching the whole map.
 */
projectsRouter.patch('/:id/languages/:code/segments', validateBody(schemas.patchLanguageSegments), async (req, res) => {
  const stored = await requireProject(req.workspaceId!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const languageCode = req.params.code;
  if (!Array.isArray(req.body?.localizedSegments)) return res.status(400).json({ error: 'localizedSegments must be an array' });
  if (!projectLanguages(stored).includes(languageCode)) {
    return res.status(404).json({ error: `Project is not being dubbed into ${languageCode}` });
  }
  // Fingerprints and render flags stay the server's; text flags are recomputed for what was saved.
  const segments = reconcileSavedSegments(req.body.localizedSegments as LocalizedSegment[], segmentsForLanguage(stored, languageCode), {
    languageCode,
    sourceLanguageCode: stored.sourceLanguage,
    glossary: await getGlossary(req.workspaceId!),
  });

  const patch: Partial<StoredProject> = {
    languageOutputs: {
      ...stored.languageOutputs,
      [languageCode]: {
        ...stored.languageOutputs?.[languageCode],
        languageCode,
        localizedSegments: segments,
        status: stored.languageOutputs?.[languageCode]?.status || 'draft',
        progressPercent: stored.languageOutputs?.[languageCode]?.progressPercent || 0,
      },
    },
  };
  if (languageCode === stored.targetLanguage) patch.localizedSegments = segments;

  const updated = await updateStoredProject(req.workspaceId!, req.params.id, patch);
  res.json(withRetakeInfo(await toClientProject(updated), updated));
});
