import type { Response } from 'express';
import { Router } from '../lib/router';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { bucket, getSignedDownloadUrl, invalidateSignedUrlCache, uploadFileToStorage } from '../lib/firebaseAdmin';
import {
  getSettings,
  getStoredProject,
  projectLanguages,
  QuotaExceededError,
  recordCompletedDub,
  segmentsForLanguage,
  updateStoredProject,
  type StoredLanguageOutput,
  type StoredProject,
} from '../lib/projectRepo';
import {
  assertStillActive,
  getJob,
  JobCancelledError,
  jobDirFor,
  JobConflictError,
  JobSupersededError,
  markJobStarted,
  markRunningHere,
  recordJobUsage,
  settleJob,
  startDubJob,
  startHeartbeat,
  writeProjectForJob,
  type DubJob,
} from '../lib/jobs';
import { refuseWhenDraining, trackBackgroundWork } from '../lib/lifecycle';
import { enqueueDub, queueStats } from '../lib/dubQueue';
import { rateLimit } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { acquireHeavySlot } from '../lib/heavyWork';
import { HttpError } from '../lib/httpError';
import { invalidateStorageUsage } from '../lib/storageUsage';
import { log, withLogContext } from '../lib/log';
import { randomUUID } from 'node:crypto';
import { routeSynthesizeSpeech, type ProviderSettings } from '../lib/modelRouter';
import {
  burnSubtitles,
  effectiveClipSeconds,
  extractAudioForStt,
  loudnessTarget,
  MAX_COMPRESSION,
  measureLoudness,
  muxVideoWithAudio,
  normalizeLoudness,
  SEGMENT_GUARD_SECONDS,
  stitchDubbedAudio,
  type TimedAudioSegment,
} from '../lib/ffmpeg';
import { getWavDurationSeconds, openWavSlicer, speechLevelDb, type WavSlicer } from '../lib/audioUtils';
import { describeVerdict, retakeStyle, reviewDubbedLines, type LineVerdict } from '../lib/dubDirector';
import { lineGainsDb } from '../lib/levelMatch';
import { stripPerformanceTags } from '../lib/performance';
import { planForWorkspace } from '../lib/plans';
import { allowanceRate, effectiveExtras, NO_EXTRAS, type PaidExtrasChoice } from '../../src/lib/planMath';
import { isVertexConfigured, vertexCondenseLine, vertexHinglishToSpeechScript } from '../lib/vertexClient';
import { buildKaraokeAss } from '../lib/captions';
import { isLipSyncAvailable, runLipSync } from '../lib/lipSync';
import { costEstimate, createCostMeter, recordTts, summarizeCost } from '../lib/costMeter';
import { isSeparationAvailable, separateBackground } from '../lib/audioSeparation';
import { getLanguageName } from '../lib/languageMeta';
import { tmpDir } from '../lib/paths';
import { resolveVoice, type VoiceSelection } from '../lib/voiceResolution';
import { createReferenceLoader, isClonedVoiceId, voiceCatalogFor } from '../lib/customVoices';
import { VOICES } from '../../src/data/mockData';
import type { GlossaryEntry, LocalizedSegment, QaFlag, Voice } from '../../src/types';
import { schemas, validateBody } from '../lib/validation';
import { getGlossary } from '../lib/glossaryStore';
import { applySpokenForms, requiredRendering } from '../lib/glossary';
import { buildStylePrompt, paceRequest } from '../lib/speechStyle';
import { renderQaFlags, textQaFlags, withFlags } from '../lib/lineReview';
import { currentLineKey, retakePlan } from '../lib/retake';

export const dubRouter = Router();

const dubLimit = rateLimit('dub', [
  ['user', rateRules.dubPerUser],
  ['workspace', rateRules.dubPerWorkspace],
]);

dubRouter.post('/:id/dub', refuseWhenDraining, dubLimit, validateBody(schemas.dub), async (req, res) => {
  const uid = req.uid!;
  const workspaceId = req.workspaceId!;
  const projectId = req.params.id;
  const stored = await getStoredProject(workspaceId, projectId);
  if (!stored) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!stored.videoStoragePath) {
    res.status(400).json({ error: 'Upload a video before dubbing' });
    return;
  }
  // Minutes are charged by duration, so a video whose length is unknown cannot be dubbed (it would be free).
  if (!(stored.videoDuration > 0)) {
    res.status(400).json({ error: 'This video has no known length. Upload it again before dubbing.', code: 'VIDEO_DURATION_UNKNOWN' });
    return;
  }
  // Any one translated language is enough to start: the pipeline renders each language it
  // finds a translation for and skips the rest, rather than refusing the whole job.
  if (!projectLanguages(stored).some((code) => segmentsForLanguage(stored, code).length > 0)) {
    res.status(400).json({ error: 'Translate the video before dubbing' });
    return;
  }

  const {
    voiceId,
    voiceSpeed,
    voicePitch,
    voiceEmotion,
    speakerVoiceMap,
    languageVoiceMap,
    languageSpeakerVoiceMap,
    autoLipSync,
    separateBackground: sepBg,
    languages: requestedLanguages,
  } = req.body || {};
  const finalVoiceId = voiceId || stored.selectedVoiceId;
  const voice = (await voiceCatalogFor(uid, VOICES)).find((v) => v.id === finalVoiceId);
  if (!voice) {
    res.status(400).json({ error: `Unknown voice id: ${finalVoiceId}` });
    return;
  }

  // Voice choices are saved even if the dub is refused below; the project only becomes "processing" once every check has passed.
  await updateStoredProject(workspaceId, projectId, {
    selectedVoiceId: finalVoiceId,
    speakerVoiceMap: speakerVoiceMap ?? stored.speakerVoiceMap,
    languageVoiceMap: languageVoiceMap ?? stored.languageVoiceMap,
    languageSpeakerVoiceMap: languageSpeakerVoiceMap ?? stored.languageSpeakerVoiceMap,
    voiceSpeed: voiceSpeed ?? stored.voiceSpeed,
    voicePitch: voicePitch ?? stored.voicePitch,
    voiceEmotion: voiceEmotion || stored.voiceEmotion,
    autoLipSync: autoLipSync ?? stored.autoLipSync,
    separateBackground: sepBg ?? stored.separateBackground,
  });

  // Re-dubbing one language of a finished multi-language project (changing its voice from
  // the workspace, say) should not re-render — and re-bill — the languages that are
  // already fine. An explicit subset limits the run to what actually changed.
  const onlyLanguages = Array.isArray(requestedLanguages)
    ? (requestedLanguages as unknown[]).filter((c): c is string => typeof c === 'string')
    : undefined;
  if (onlyLanguages?.length) {
    const known = projectLanguages(stored);
    const unknown = onlyLanguages.filter((code) => !known.includes(code));
    if (unknown.length) {
      res.status(400).json({ error: `Project is not being dubbed into ${unknown.join(', ')}` });
      return;
    }
  }

  // Strict monthly limit: every language rendered is a full video's worth of minutes, charged before any work starts.
  const languagesToRender = projectLanguages(stored)
    .filter((code) => !onlyLanguages?.length || onlyLanguages.includes(code))
    .filter((code) => segmentsForLanguage(stored, code).length > 0);
  if (languagesToRender.length === 0) {
    res.status(400).json({ error: 'Translate the video before dubbing' });
    return;
  }
  // Paid extras the starter switched on (and their plan allows) make each dubbed minute use more of the allowance.
  const { extras, rate } = await chargedExtras(workspaceId, uid);
  const minutesPerLanguage = (stored.videoDuration / 60) * rate;

  const started = await startJobOrRefuse(
    res,
    {
      workspaceId,
      projectId,
      userId: uid,
      languages: languagesToRender,
      minutes: minutesPerLanguage * languagesToRender.length,
      idempotencyKey: req.get('Idempotency-Key') || undefined,
      extras,
    },
    rate
  );
  if (!started) return;
  res.status(202).json({ status: 'processing', jobId: started.job.id });

  // The same request replayed: its job is already running (or finished), so nothing new is started.
  if (started.replayed) return;
  // The client polls GET /api/projects/:id for progress; the job starts as soon as the queue admits it.
  enqueueDubJob(started.job);
});

// The extras a dub started now gets under the workspace plan, and how fast they make it use the allowance.
async function chargedExtras(workspaceId: string, uid: string): Promise<{ extras: PaidExtrasChoice; rate: number }> {
  const [plan, settings] = await Promise.all([planForWorkspace(workspaceId), getSettings(uid)]);
  const extras = effectiveExtras(plan.paidExtras, settings.preferences);
  return { extras, rate: allowanceRate(plan.extraRates, extras) };
}

// Job, project ownership and minute reservation are one transaction: a double click or a second teammate gets a 409, never a second charge.
async function startJobOrRefuse(res: Response, input: Parameters<typeof startDubJob>[0], rate = 1): Promise<{ job: DubJob; replayed: boolean } | null> {
  try {
    return await startDubJob(input);
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      const extrasHint = rate > 1 ? ` Paid extras are on, so each dubbed minute uses ${rate} min; turning them off in Settings uses less.` : '';
      res.status(403).json({ error: `${err.message}${extrasHint}`, code: 'QUOTA_EXCEEDED' });
      return null;
    }
    if (err instanceof JobConflictError) {
      res.status(409).json({ error: err.message, code: 'JOB_ALREADY_RUNNING', jobId: err.jobId });
      return null;
    }
    throw err;
  }
}

// Re-renders one language after line edits, charging only for the lines whose fingerprint changed since its last render.
dubRouter.post('/:id/languages/:code/retake', refuseWhenDraining, dubLimit, async (req, res) => {
  const workspaceId = req.workspaceId!;
  const projectId = req.params.id;
  const languageCode = req.params.code;
  const stored = await getStoredProject(workspaceId, projectId);
  if (!stored) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!projectLanguages(stored).includes(languageCode)) {
    res.status(404).json({ error: `Project is not being dubbed into ${languageCode}` });
    return;
  }
  if (!stored.videoStoragePath || !(stored.videoDuration > 0)) {
    res.status(400).json({ error: 'This video has no known length. Upload it again before dubbing.', code: 'VIDEO_DURATION_UNKNOWN' });
    return;
  }
  const plan = retakePlan(stored, languageCode);
  if (!plan) {
    res.status(400).json({ error: `${getLanguageName(languageCode)} has no line-level render to update yet. Re-dub it instead.`, code: 'RETAKE_UNAVAILABLE' });
    return;
  }
  if (plan.changedLineIds.length === 0) {
    res.status(400).json({ error: `Nothing changed in ${getLanguageName(languageCode)} since its last render.`, code: 'NOTHING_TO_RETAKE' });
    return;
  }

  const { extras, rate } = await chargedExtras(workspaceId, req.uid!);
  const minutes = Math.round(plan.minutes * rate * 10) / 10;
  const started = await startJobOrRefuse(
    res,
    {
      workspaceId,
      projectId,
      userId: req.uid!,
      languages: [languageCode],
      minutes,
      idempotencyKey: req.get('Idempotency-Key') || undefined,
      extras,
    },
    rate
  );
  if (!started) return;
  res.status(202).json({ status: 'processing', jobId: started.job.id, changedLines: plan.changedLineIds.length, minutes });
  if (started.replayed) return;
  enqueueDubJob(started.job);
});

export const QUEUED_MESSAGE = 'Waiting in the queue: other dubs in this workspace are rendering. Yours starts automatically.';

// Queues a job; this process then owns it (fresh heartbeat, awaited on shutdown) until it finishes or is released.
export function enqueueDubJob(job: DubJob): void {
  const stopHeartbeat = startHeartbeat(job.id);
  const unmark = markRunningHere(job.id);
  let finished!: () => void;
  void trackBackgroundWork(new Promise<void>((resolve) => (finished = resolve)));
  const release = () => {
    stopHeartbeat();
    unmark();
    finished();
  };
  const { startedImmediately } = enqueueDub({
    jobId: job.id,
    workspaceId: job.workspaceId,
    start: async () => {
      try {
        if (await markJobStarted(job)) await runDubJob(job, pipelineImpl);
      } finally {
        release();
      }
    },
    abandon: release,
  });
  if (!startedImmediately) {
    log.info('job_queued', { type: 'dub', jobId: job.id, workspaceId: job.workspaceId, ...queueStats() });
    void writeProjectForJob(job, { currentProcessingMessage: QUEUED_MESSAGE }).catch(() => undefined);
  }
}

// Test seam: lets job tests hold a run open or fail it on cue without real media, providers or ffmpeg.
let pipelineImpl: (job: DubJob) => Promise<PipelineResult> = (job) => runDubPipeline(job);
export function setDubPipelineForTests(fn: ((job: DubJob) => Promise<PipelineResult>) | null): void {
  pipelineImpl = fn ?? ((job) => runDubPipeline(job));
}

// Runs a job's pipeline and settles it exactly once: failed languages are refunded, and a pipeline crash refunds everything.
export function runDubJob(job: DubJob, pipeline: (job: DubJob) => Promise<PipelineResult> = runDubPipeline): Promise<void> {
  // Every log line from this run, down to provider retries, carries the job's ids.
  return withLogContext({ jobId: job.id, projectId: job.projectId, workspaceId: job.workspaceId, userId: job.userId }, () => runDubJobInContext(job, pipeline));
}

// What users see when a run fails for a reason that is not theirs to fix; the real cause is in the logs under the job id.
export const DUB_FAILED_MESSAGE = 'Dubbing failed. Your minutes were not charged; please try again.';
export const DUB_CANCELLED_MESSAGE = 'Dubbing was cancelled. Languages that had not finished were not charged.';

async function runDubJobInContext(job: DubJob, pipeline: (job: DubJob) => Promise<PipelineResult>): Promise<void> {
  const minutesPerLanguage = job.languages.length ? job.minutesReserved / job.languages.length : 0;
  const started = Date.now();
  log.info('job_started', { type: 'dub', languages: job.languages, attempt: job.attemptCount, queuedMs: started - new Date(job.createdAt).getTime() });
  try {
    const result = await pipeline(job);
    const failed = job.languages.filter((code) => !result.completed.includes(code));
    log.info('job_finished', {
      type: 'dub',
      status: failed.length ? 'partially_completed' : 'completed',
      durationMs: Date.now() - started,
      completedLanguages: result.completed,
      failedLanguages: failed,
    });
    const settled = await settleJob(job.id, {
      status: failed.length ? 'partially_completed' : 'completed',
      refundMinutes: minutesPerLanguage * failed.length,
      completedLanguages: result.completed,
      failedLanguages: failed,
      projectPatch: result.projectPatch,
    });
    // Lifetime counters only for the run that actually settled, so a replay cannot count a dub twice.
    invalidateStorageUsage(job.workspaceId);
    if (settled) {
      for (const languageCode of result.completed) {
        await recordCompletedDub(job.workspaceId, { wordsAdded: result.wordsCount, targetLanguageCode: languageCode, fileSizeMb: result.fileSizeMb });
      }
    }
  } catch (err) {
    if (err instanceof JobSupersededError) {
      log.warn('job_superseded', { type: 'dub', durationMs: Date.now() - started }, `[dub] job ${job.id} lost ownership of ${job.projectId}; stopping without writing`);
      return;
    }
    if (err instanceof JobCancelledError) {
      // Languages that finished before the cancel are kept (and billed); the rest are refunded.
      const done = (await getJob(job.id))?.completedLanguages ?? [];
      const errorCode = err.reason === 'timeout' ? 'TIMEOUT' : 'CANCELLED';
      log.warn('job_cancelled', { type: 'dub', errorCode, completedLanguages: done, durationMs: Date.now() - started });
      await settleJob(job.id, {
        status: 'cancelled',
        refundMinutes: minutesPerLanguage * (job.languages.length - done.length),
        errorCode,
        errorMessage: err.message,
        userMessage: DUB_CANCELLED_MESSAGE,
        completedLanguages: done,
        projectPatch: { status: 'failed', currentProcessingMessage: DUB_CANCELLED_MESSAGE },
      }).catch((settleErr) => log.error('job_settle_failed', settleErr));
      return;
    }
    const errorCode = err instanceof HttpError ? err.code : 'DUB_FAILED';
    log.error('job_failed', err, { type: 'dub', errorCode, durationMs: Date.now() - started });
    // The full reason stays on the job record (server-side only); the project, which users see, gets a safe message.
    const userMessage = err instanceof HttpError ? err.message : DUB_FAILED_MESSAGE;
    await settleJob(job.id, {
      status: 'failed',
      refundMinutes: job.minutesReserved,
      errorCode,
      errorMessage: (err as Error).message || 'Dubbing failed',
      userMessage,
      projectPatch: { status: 'failed', currentProcessingMessage: userMessage },
    }).catch((settleErr) => log.error('job_settle_failed', settleErr));
  }
}

/**
 * Chooses what the dubbed voice should sit on top of.
 *
 * Preferred: a vocals-removed stem, so the original soundtrack keeps playing continuously
 * underneath the dub. Fallback: the untouched source audio, which the caller then mutes
 * only while the dubbed voice speaks — that still preserves applause/music between lines,
 * which is where most of it lives, without ever letting the original speaker be heard.
 */
async function prepareBackgroundBed(
  videoLocalPath: string,
  jobDir: string,
  job: DubJob,
  useSeparation: boolean
): Promise<{ path: string; isVocalsRemoved: boolean }> {
  if (useSeparation && isSeparationAvailable()) {
    await writeProjectForJob(job, {
      // Still inside the shared-setup slice of the bar: separation runs once for the whole
      // job, before any language starts rendering.
      progressPercent: 10,
      currentProcessingMessage: 'Separating background audio (music, applause) from speech...',
    }, { stage: 'separating_audio', progress: 10 });
    const stem = await separateBackground(videoLocalPath, jobDir);
    if (stem) return { path: stem, isVocalsRemoved: true };
    console.warn('[dub] separation unavailable/failed, keeping background via ducking instead');
  }
  return { path: videoLocalPath, isVocalsRemoved: false };
}

/**
 * Turns the localized lines into the spans where the bed has to give way to the dub.
 *
 * Overlapping and touching lines are merged into one span. ffmpeg's `enable` is a single
 * OR of `between()` terms, so leaving a term per line in it makes the filtergraph grow
 * with the transcript for no benefit — and on a long video that argument gets big enough
 * to matter.
 *
 * A raw source bed still carries the original speaker, so its spans are padded wider: the
 * segment boundaries are approximate, and even a fraction of a second of un-ducked source
 * is the original voice audible alongside the dub. A vocals-removed stem has no voice left
 * to leak, so it is padded only enough to cover the dubbed line itself.
 */
function buildDuckRegions(
  segments: { startTime: number; endTime: number }[],
  isVocalsRemoved: boolean
): { start: number; end: number }[] {
  const guard = isVocalsRemoved ? 0.08 : 0.25;
  const spans = segments
    .map((s) => ({ start: Math.max(0, s.startTime - guard), end: s.endTime + guard }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const merged: { start: number; end: number }[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * Renders one language: synthesize every line, lay them onto the shared background bed,
 * and mux the result against the original picture.
 *
 * Everything upstream of this — the download, and above all the vocal separation, which
 * costs minutes of CPU — is done once by the caller and handed in, because it is identical
 * for every language. That sharing is the whole reason dubbing five languages together
 * beats running five separate projects.
 */
async function renderLanguage(params: {
  job: DubJob;
  workspaceId: string;
  projectId: string;
  stored: StoredProject;
  languageCode: string;
  segments: LocalizedSegment[];
  videoLocalPath: string;
  background: { path: string; isVocalsRemoved: boolean };
  jobDir: string;
  costMeter: ReturnType<typeof createCostMeter>;
  voiceSelection: VoiceSelection;
  voiceCatalog: (typeof VOICES)[number][];
  loadCloneReference: (voiceId: string) => Promise<{ audioPath: string; transcript?: string }>;
  ttsProvider: ProviderSettings['ttsProvider'];
  expressiveVoices: boolean;
  glossary: GlossaryEntry[];
  // The original's speech track (16 kHz), for per-line levels and the AI review; null when it could not be extracted.
  sourceSpeech: WavSlicer | null;
  // The paid extras the user who started the dub switched on (Settings): AI review, premium voices, pace re-takes.
  aiReview: boolean;
  premiumVoices: boolean;
  paceRetakes: boolean;
  // Integrated loudness (LUFS) the finished track is levelled to, taken from the original; null skips levelling.
  loudnessLufs: number | null;
  onProgress: (fraction: number, message: string) => Promise<void>;
}): Promise<{ paths: { dubbedAudioStoragePath: string; finalDubbedVideoStoragePath: string }; segments: LocalizedSegment[] }> {
  const { workspaceId, projectId, stored, languageCode, segments, videoLocalPath, background, costMeter } = params;
  const languageName = getLanguageName(languageCode);
  // Each language renders in its own directory: the stitcher writes fixed filenames
  // (seg_0.wav, dubbed_audio.wav), so a shared directory would have each language
  // overwrite the one before it.
  const langDir = path.join(params.jobDir, languageCode);
  await mkdir(langDir, { recursive: true });

  // Copies, so a line condensed to fit its slot is saved with the text that was actually spoken.
  const finalSegments = segments.map((s) => ({ ...s }));
  const isHinglish = languageCode === 'hinglish';
  // Hinglish is displayed romanized but voiced from Devanagari, which the hi-IN voices pronounce far more reliably.
  const speechScript: Record<string, string> = isHinglish
    ? await vertexHinglishToSpeechScript(
        finalSegments.filter((s) => s.translatedText.trim()).map((s) => ({ id: s.id, text: s.translatedText }))
      ).catch((err) => {
        console.error('[dub] Hinglish speech-script conversion failed, voicing romanized text', err);
        return {};
      })
    : {};

  // Lines are reviewed against the same rules as on save, plus how their audio fit the slot.
  const review = { languageCode, sourceLanguageCode: stored.sourceLanguage, glossary: params.glossary };
  const protectedTerms = params.glossary.map((entry) => requiredRendering(entry, languageCode)).filter((term): term is string => Boolean(term));

  // One per spoken line: its current take and everything needed to judge or re-record it.
  interface LineTake {
    index: number;
    audio: Buffer;
    engine: 'gemini' | 'chirp' | 'clone';
    speechText: string;
    style: string;
    voice: Voice;
    cloneReference?: { audioPath: string; transcript?: string };
    available: number;
    condensed: boolean;
    sourceDb: number | null;
    directorNote?: string;
  }
  const takes: LineTake[] = [];

  const synthesizeLine = async (speechText: string, voice: Voice, cloneReference: LineTake['cloneReference'], style: string, take = 0) => {
    const result = await routeSynthesizeSpeech(applySpokenForms(speechText, params.glossary), voice, languageCode, params.ttsProvider, {
      cloneReference,
      style,
      expressive: params.expressiveVoices,
      take,
      premium: params.premiumVoices,
    });
    recordTts(costMeter, result.engine === 'gemini' ? 'gemini-tts' : result.provider, speechText.length, result.fromCache);
    const engine: LineTake['engine'] = result.provider === 'clone' ? 'clone' : (result.engine ?? 'chirp');
    return { audio: result.audio, engine };
  };
  // How long a take will actually play once the user's pitch and speed are applied.
  const playedSeconds = (audio: Buffer) => effectiveClipSeconds(getWavDurationSeconds(audio), stored.voicePitch, stored.voiceSpeed);

  for (let i = 0; i < finalSegments.length; i++) {
    const seg = finalSegments[i];
    // A segment with no text (e.g. a silent lead-in the STT step correctly
    // transcribed as empty) has nothing to synthesize — every provider rejects an
    // empty string outright. Leave that span silent in the stitched track instead.
    if (seg.translatedText.trim().length > 0) {
      // Resolved per line, not once per render: the voice can differ by speaker as well
      // as by language, and both are only known here.
      const voice = resolveVoice(params.voiceSelection, languageCode, seg.speaker, params.voiceCatalog);
      const cloneReference = isClonedVoiceId(voice.id) ? await params.loadCloneReference(voice.id) : undefined;
      // The project's overall emotion plus how the original line was delivered.
      const style = buildStylePrompt(stored.voiceEmotion, seg.delivery);
      let speechText = speechScript[seg.id] || seg.translatedText;
      let { audio, engine } = await synthesizeLine(speechText, voice, cloneReference, style);

      // The room this line has before the next one starts; past it the voices overlap and the dub drifts off the picture.
      const nextSpoken = finalSegments.slice(i + 1).find((s) => s.translatedText.trim().length > 0);
      const nextStart = nextSpoken ? nextSpoken.startTime : stored.videoDuration;
      const slot = seg.endTime - seg.startTime;
      const available = Math.max(slot, nextStart - seg.startTime - SEGMENT_GUARD_SECONDS);
      let spokenSeconds = playedSeconds(audio);
      let wasCondensed = false;

      // Pace first: a voice asked to speed up or take its time still sounds like a person; audio stretched afterwards does not.
      const pace = params.paceRetakes && engine === 'gemini' ? paceRequest(spokenSeconds, slot, available, spokenSeconds > 0 ? getWavDurationSeconds(audio) / spokenSeconds : 1) : null;
      if (pace) {
        try {
          const paced = await synthesizeLine(speechText, voice, cloneReference, `${style} ${pace.direction}`.trim());
          const pacedSeconds = playedSeconds(paced.audio);
          if (pace.accept(pacedSeconds, spokenSeconds)) {
            audio = paced.audio;
            spokenSeconds = pacedSeconds;
          }
        } catch (err) {
          console.error(`[dub] paced take of ${seg.id} failed, keeping the first take`, err);
        }
      }

      // Too long to fit even at the fastest natural pace: rewrite it shorter rather than gabble or overlap. Hand-edited lines are left as the user wrote them.
      if (!seg.isEdited && spokenSeconds > available * MAX_COMPRESSION) {
        try {
          const condensed = await vertexCondenseLine(seg.translatedText, languageCode, languageName, available * 1.1, spokenSeconds, protectedTerms);
          if (condensed) {
            const condensedSpeech = isHinglish
              ? (await vertexHinglishToSpeechScript([{ id: seg.id, text: condensed }]))[seg.id] || condensed
              : condensed;
            const retake = await synthesizeLine(condensedSpeech, voice, cloneReference, style);
            if (getWavDurationSeconds(retake.audio) < getWavDurationSeconds(audio)) {
              console.log(`[dub] ${languageCode} ${seg.id}: condensed to fit ${available.toFixed(1)}s slot (was ${spokenSeconds.toFixed(1)}s)`);
              audio = retake.audio;
              engine = retake.engine;
              speechText = condensedSpeech;
              seg.translatedText = condensed;
              wasCondensed = true;
              spokenSeconds = playedSeconds(audio);
            }
          }
        } catch (err) {
          console.error(`[dub] condensing ${seg.id} failed, keeping the full line`, err);
        }
      }
      takes.push({ index: i, audio, engine, speechText, style, voice, cloneReference, available, condensed: wasCondensed, sourceDb: null });
    }
    await params.onProgress(
      segments.length ? ((i + 1) / segments.length) * 0.6 : 0.6,
      `${languageName}: generating neural voice audio (${i + 1}/${segments.length})...`
    );
  }

  // The original line under each take: its level always, and the AI review when it is on. Read in groups so a long video never sits in memory whole.
  const verdicts = new Map<string, LineVerdict>();
  const REVIEW_GROUP = 48;
  for (let g = 0; g < takes.length; g += REVIEW_GROUP) {
    const group = takes.slice(g, g + REVIEW_GROUP);
    const originals = await Promise.all(
      group.map((t) => params.sourceSpeech?.slice(finalSegments[t.index].startTime, finalSegments[t.index].endTime) ?? Promise.resolve(null))
    );
    group.forEach((t, k) => (t.sourceDb = originals[k] ? speechLevelDb(originals[k]!) : null));
    if (!params.aiReview) continue;
    await params.onProgress(0.6 + (g / takes.length) * 0.08, `${languageName}: AI reviewer listening to every line (${g + group.length}/${takes.length})...`);
    const found = await reviewDubbedLines(
      group.map((t, k) => ({
        id: finalSegments[t.index].id,
        script: t.speechText,
        delivery: finalSegments[t.index].delivery,
        original: originals[k] ?? undefined,
        dubbed: t.audio,
      })),
      languageName
    );
    for (const [id, verdict] of found) verdicts.set(id, verdict);
  }

  // One re-recording per line the reviewer rejected, kept only if the reviewer accepts it; Chirp3-HD would only repeat itself, so its lines are flagged.
  const rejected = takes.filter((t) => verdicts.get(finalSegments[t.index].id)?.ok === false);
  if (rejected.length) {
    await params.onProgress(0.69, `${languageName}: re-recording ${rejected.length} line${rejected.length === 1 ? '' : 's'} the AI reviewer flagged...`);
    const retakes: { take: LineTake; audio: Buffer }[] = [];
    for (const t of rejected) {
      const verdict = verdicts.get(finalSegments[t.index].id)!;
      t.directorNote = describeVerdict(verdict);
      if (t.engine === 'chirp') continue;
      try {
        const retake = await synthesizeLine(t.speechText, t.voice, t.cloneReference, retakeStyle(t.style, verdict), 1);
        retakes.push({ take: t, audio: retake.audio });
      } catch (err) {
        console.error(`[dub] retake of ${finalSegments[t.index].id} failed, keeping the first take`, err);
      }
    }
    if (retakes.length) {
      const second = await reviewDubbedLines(
        await Promise.all(
          retakes.map(async ({ take, audio }) => ({
            id: finalSegments[take.index].id,
            script: take.speechText,
            delivery: finalSegments[take.index].delivery,
            original: (await params.sourceSpeech?.slice(finalSegments[take.index].startTime, finalSegments[take.index].endTime)) ?? undefined,
            dubbed: audio,
          }))
        ),
        languageName
      );
      let fixed = 0;
      for (const { take, audio } of retakes) {
        if (second.get(finalSegments[take.index].id)?.ok !== true) continue;
        take.audio = audio;
        take.directorNote = undefined;
        fixed++;
      }
      log.info('dub_review', { languageCode, reviewed: verdicts.size, rejected: rejected.length, retaken: retakes.length, fixed });
    }
  }

  // Each line at the level the original speaker used, relative to the rest (whispers stay quiet, shouts stay loud).
  const gains = lineGainsDb(takes.map((t) => ({ id: finalSegments[t.index].id, sourceDb: t.sourceDb, dubDb: speechLevelDb(t.audio) })));

  const timedAudio: TimedAudioSegment[] = [];
  const takeByIndex = new Map(takes.map((t) => [t.index, t]));
  for (let i = 0; i < finalSegments.length; i++) {
    const seg = finalSegments[i];
    const take = takeByIndex.get(i);
    const renderFlags: QaFlag[] = take
      ? [
          ...renderQaFlags({ condensed: take.condensed, spokenSeconds: playedSeconds(take.audio), availableSeconds: take.available, maxCompression: MAX_COMPRESSION }),
          ...(take.directorNote ? (['director'] as QaFlag[]) : []),
        ]
      : [];
    if (take) timedAudio.push({ startTime: seg.startTime, endTime: seg.endTime, audio: take.audio, gainDb: gains.get(seg.id) });
    // Every line, spoken or silent, records what was rendered, so a later retake can tell exactly which lines changed.
    finalSegments[i] = withFlags(
      { ...seg, renderKey: currentLineKey(stored, languageCode, seg), ...(take?.directorNote ? { directorNote: take.directorNote } : {}) },
      [...textQaFlags(seg, review), ...renderFlags]
    );
  }

  await params.onProgress(0.75, `${languageName}: synchronizing dubbed audio timeline...`);
  let stitchedAudioPath = await stitchDubbedAudio({
    segments: timedAudio,
    totalDurationSeconds: stored.videoDuration,
    pitch: stored.voicePitch,
    speed: stored.voiceSpeed,
    workDir: langDir,
    background: {
      path: background.path,
      // Ducked across every span the original speaker talks in — taken from all
      // localized segments, not just the ones that produced audio, since a segment
      // whose translation came back empty still has the original voice under it and
      // would otherwise play through untouched.
      duckRegions: buildDuckRegions(segments, background.isVocalsRemoved),
      // Separation is imperfect, so a stem still gets attenuated over speech to bury any
      // leftover vocal — but only attenuated, so its music/ambience keeps playing. A raw
      // source track is muted outright; there the original voice must be silent.
      duckLevel: background.isVocalsRemoved ? 0.3 : 0,
    },
  });

  // As loud as the original, measured the way streaming platforms measure it, so the dub never plays quieter or louder than the source did.
  if (params.loudnessLufs !== null) {
    await params.onProgress(0.8, `${languageName}: matching loudness to the original...`);
    const leveledPath = path.join(langDir, 'dubbed_audio_leveled.wav');
    if (await normalizeLoudness(stitchedAudioPath, leveledPath, params.loudnessLufs)) stitchedAudioPath = leveledPath;
  }

  await params.onProgress(0.82, `${languageName}: rendering final dubbed master video...`);
  let finalVideoPath = path.join(langDir, 'dubbed.mp4');
  await muxVideoWithAudio(videoLocalPath, stitchedAudioPath, finalVideoPath);

  if (stored.autoLipSync && isLipSyncAvailable()) {
    await params.onProgress(0.86, `${languageName}: running lip-sync (CPU-only — this can take several minutes)...`);
    const lipSyncedPath = path.join(langDir, 'dubbed_lipsynced.mp4');
    try {
      await runLipSync(finalVideoPath, lipSyncedPath);
      finalVideoPath = lipSyncedPath;
    } catch (err) {
      // Best-effort enhancement, not a core requirement (e.g. no clear face in the
      // video) — fall back to the non-lip-synced render rather than failing the dub.
      console.error('[dub] lip-sync failed, continuing with non-lip-synced video', err);
    }
  }

  await params.onProgress(0.95, `${languageName}: uploading export...`);
  await assertStillActive(params.job);
  const dubbedAudioStoragePath = `workspaces/${workspaceId}/projects/${projectId}/dubbed_audio_${languageCode}.wav`;
  const finalDubbedVideoStoragePath = `workspaces/${workspaceId}/projects/${projectId}/dubbed_${languageCode}.mp4`;
  await uploadFileToStorage(dubbedAudioStoragePath, stitchedAudioPath, 'audio/wav');
  await uploadFileToStorage(finalDubbedVideoStoragePath, finalVideoPath, 'video/mp4');
  // A re-dub overwrites these same paths — drop any cached signed URL so the next
  // read mints a fresh one immediately instead of serving stale cached bytes.
  invalidateSignedUrlCache(dubbedAudioStoragePath);
  invalidateSignedUrlCache(finalDubbedVideoStoragePath);
  // Any captioned variant was burned from the *previous* render of this language, so it is
  // now stale — drop it and let the next captioned download rebuild it.
  const stalePath = captionedStoragePathFor(workspaceId, projectId, languageCode);
  await bucket.file(stalePath).delete({ ignoreNotFound: true });
  invalidateSignedUrlCache(stalePath);

  return { paths: { dubbedAudioStoragePath, finalDubbedVideoStoragePath }, segments: finalSegments };
}

export interface PipelineResult {
  completed: string[];
  projectPatch: Partial<StoredProject>;
  wordsCount: number;
  fileSizeMb: number;
}

// Renders the job's languages; the final project fields are returned rather than written, so settlement applies them atomically.
async function runDubPipeline(job: DubJob): Promise<PipelineResult> {
  const { workspaceId, projectId, userId: uid } = job;
  const stored = await getStoredProject(workspaceId, projectId);
  if (!stored) throw new Error('Project disappeared mid-pipeline');
  // The user's cloned voices are part of their catalog, so a project dubbed in the user's
  // own voice resolves here just like one using a built-in voice.
  const voiceCatalog = await voiceCatalogFor(uid, VOICES);
  if (!voiceCatalog.some((v) => v.id === stored.selectedVoiceId)) {
    throw new Error(`Unknown voice id: ${stored.selectedVoiceId}`);
  }
  // Every layer the user can have set: a voice for a given speaker in a given language, a
  // voice for a language, a voice for a speaker across languages, and the global default.
  // `resolveVoice` walks them most-specific-first for each individual line.
  const voiceSelection: VoiceSelection = {
    languageSpeakerVoiceMap: stored.languageSpeakerVoiceMap,
    languageVoiceMap: stored.languageVoiceMap,
    speakerVoiceMap: stored.speakerVoiceMap,
    selectedVoiceId: stored.selectedVoiceId,
  };
  const settings = await getSettings(uid);
  const glossary = await getGlossary(workspaceId);

  // Decided (and charged for) when the job was created.
  const languages = job.languages;
  if (languages.length === 0) throw new Error('Translate the video before dubbing');

  const jobDir = jobDirFor(job.id);
  await mkdir(jobDir, { recursive: true });
  const costMeter = createCostMeter();
  // One download per cloned voice for the whole render, not one per line.
  const loadCloneReference = createReferenceLoader(uid, jobDir);
  // Held open across languages and closed before the job directory is removed.
  let sourceSpeech: WavSlicer | null = null;

  try {
    await writeProjectForJob(job, { progressPercent: 8, currentProcessingMessage: 'Preparing source audio...' }, { stage: 'preparing_audio', progress: 8 });
    // Needed before stitching: the source audio becomes the bed the dub sits on, so
    // applause/music/ambience survive into the export instead of being replaced by silence.
    const videoLocalPath = path.join(jobDir, 'source.mp4');
    await bucket.file(stored.videoStoragePath!).download({ destination: videoLocalPath });

    const background = await prepareBackgroundBed(videoLocalPath, jobDir, job, Boolean(stored.separateBackground));

    // Shared by every language: the original's speech (per-line levels, AI review) and its loudness. Both are refinements, so failures are logged, not fatal.
    // Exactly the extras this dub was charged for when it started; jobs from before plans had none.
    const extras = job.extras ?? NO_EXTRAS;
    const aiReview = extras.aiReview && isVertexConfigured();
    const { premiumVoices, paceRetakes } = extras;
    const sourceSpeechPath = path.join(jobDir, 'source_speech.wav');
    sourceSpeech = await extractAudioForStt(videoLocalPath, sourceSpeechPath)
      .then(() => openWavSlicer(sourceSpeechPath))
      .catch((err) => {
        console.error('[dub] could not extract the original speech track; lines keep their synthesized levels', err);
        return null;
      });
    const sourceLoudness = await measureLoudness(videoLocalPath);
    const loudnessLufs = loudnessTarget(sourceLoudness);

    // Separation, when it runs, is by far the longest step, so the shared setup gets a
    // fixed slice of the bar up front and the languages split what is left evenly.
    const SETUP_FRACTION = 0.15;
    const languageOutputs: Record<string, StoredLanguageOutput> = { ...stored.languageOutputs };
    const failures: string[] = [];
    let primaryPaths: { dubbedAudioStoragePath: string; finalDubbedVideoStoragePath: string } | null = null;

    for (let i = 0; i < languages.length; i++) {
      const languageCode = languages[i];
      const segments = segmentsForLanguage(stored, languageCode);
      const onProgress = async (fraction: number, message: string) => {
        const overall = SETUP_FRACTION + ((i + fraction) / languages.length) * (1 - SETUP_FRACTION);
        const progressPercent = Math.min(99, Math.round(overall * 100));
        await writeProjectForJob(
          job,
          { progressPercent, currentProcessingMessage: languages.length > 1 ? `[${i + 1}/${languages.length}] ${message}` : message },
          { stage: `rendering:${languageCode}`, progress: progressPercent }
        );
      };

      try {
        const { paths, segments: renderedSegments } = await renderLanguage({
          job,
          workspaceId,
          projectId,
          stored,
          languageCode,
          segments,
          videoLocalPath,
          background,
          jobDir,
          costMeter,
          voiceSelection,
          voiceCatalog,
          loadCloneReference,
          ttsProvider: settings.ttsProvider,
          // The choice of whoever started the dub.
          expressiveVoices: settings.preferences.expressiveVoices,
          glossary,
          sourceSpeech,
          aiReview,
          premiumVoices,
          paceRetakes,
          loudnessLufs,
          onProgress,
        });
        languageOutputs[languageCode] = {
          ...languageOutputs[languageCode],
          languageCode,
          localizedSegments: renderedSegments,
          status: 'completed',
          progressPercent: 100,
          message: undefined,
          wordsCount: segments.reduce((sum, s) => sum + stripPerformanceTags(s.translatedText).split(/\s+/).filter(Boolean).length, 0),
          ...paths,
        };
        if (languageCode === stored.targetLanguage) primaryPaths = paths;
      } catch (err) {
        // Losing ownership or being cancelled is not a language failure: the whole run has to stop.
        if (err instanceof JobSupersededError || err instanceof JobCancelledError) throw err;
        // One language failing (no voice covers it, a provider outage mid-run) must not
        // throw away the languages that already rendered or the ones still queued behind.
        log.error('language_failed', err, { languageCode }, `[dub] ${languageCode} failed`);
        failures.push(getLanguageName(languageCode));
        languageOutputs[languageCode] = {
          ...languageOutputs[languageCode],
          languageCode,
          localizedSegments: segments,
          status: 'failed',
          progressPercent: 0,
          message: err instanceof HttpError ? err.message : `${getLanguageName(languageCode)} could not be rendered. Try this language again.`,
        };
      }
      // Persisted after every language, so a finished one is downloadable immediately
      // instead of waiting on the ones still rendering.
      await writeProjectForJob(job, { languageOutputs }, {
        completedLanguages: languages.filter((code) => languageOutputs[code]?.status === 'completed'),
        failedLanguages: languages.filter((code) => languageOutputs[code]?.status === 'failed'),
      });
    }

    const completed = languages.filter((code) => languageOutputs[code]?.status === 'completed');
    if (completed.length === 0) {
      throw new HttpError(500, 'ALL_LANGUAGES_FAILED', `Dubbing failed for every language (${failures.join(', ')}). Your minutes were not charged; please try again.`);
    }

    // The top-level render fields track the primary language. Three cases:
    //  - the primary language rendered: point at its new files.
    //  - this run didn't include the primary language (a single-language re-dub of some
    //    other language): leave the top level exactly as it was, or the finished primary
    //    render would be swapped out for an unrelated one.
    //  - the primary language was included and failed: fall back to whatever did render,
    //    so the export screen has a video rather than a dead link.
    const primaryWasRequested = languages.includes(stored.targetLanguage);
    const headlineLanguage = primaryPaths || !primaryWasRequested ? stored.targetLanguage : completed[0];
    const headlinePaths =
      primaryPaths ??
      (primaryWasRequested
        ? {
            dubbedAudioStoragePath: languageOutputs[completed[0]].dubbedAudioStoragePath!,
            finalDubbedVideoStoragePath: languageOutputs[completed[0]].finalDubbedVideoStoragePath!,
          }
        : {
            dubbedAudioStoragePath: stored.dubbedAudioStoragePath,
            finalDubbedVideoStoragePath: stored.finalDubbedVideoStoragePath,
          });

    const wordsCount = stored.transcriptSegments.reduce((sum, s) => sum + s.wordsCount, 0);
    const projectPatch: Partial<StoredProject> = {
      status: 'completed',
      currentStep: 'export',
      progressPercent: 100,
      targetLanguage: headlineLanguage,
      localizedSegments: languageOutputs[headlineLanguage]?.localizedSegments ?? segmentsForLanguage(stored, headlineLanguage),
      languageOutputs,
      ...headlinePaths,
      wordsCount,
      currentProcessingMessage: failures.length
        ? `Finished ${completed.length}/${languages.length} languages — failed: ${failures.join(', ')}`
        : undefined,
    };
    // Counted per rendered language by the caller: each is its own full TTS + render pass.
    const fileSizeMb = Number((stored.videoFileSize || '0').replace(/[^0-9.]/g, '')) || 0;
    return { completed, projectPatch, wordsCount, fileSizeMb };
  } finally {
    const usage = costEstimate(costMeter);
    log.info('job_cost', { type: 'dub', ...usage }, `[cost] dub ${projectId}: ${summarizeCost(costMeter)}`);
    await recordJobUsage(job.id, { ...usage });
    await sourceSpeech?.close().catch(() => undefined);
    await rm(jobDir, { recursive: true, force: true });
  }
}

/**
 * Where a language's burned-in-captions render is cached. One per language, because the
 * captions are that language's own translated text over that language's own video.
 */
function captionedStoragePathFor(workspaceId: string, projectId: string, languageCode: string): string {
  return `workspaces/${workspaceId}/projects/${projectId}/dubbed_captioned_${languageCode}.mp4`;
}

/**
 * Returns the URL to download for this export — either the plain dubbed video (fast,
 * no captions) or a captioned variant burned in on demand from the same source render.
 * The captioned variant is rendered once per language and cached at a fixed storage path
 * so repeat downloads with captions on are instant after the first.
 *
 * `languageCode` picks which language to download; omitting it returns the project's
 * primary language, which is what a client written before multi-language dubbing expects.
 */
dubRouter.post('/:id/export-video', rateLimit('export', [['user', rateRules.exportPerUser]]), validateBody(schemas.exportVideo), async (req, res) => {
  const workspaceId = req.workspaceId!;
  const projectId = req.params.id;
  const stored = await getStoredProject(workspaceId, projectId);
  if (!stored) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }

  const languageCode: string = req.body?.languageCode || stored.targetLanguage;
  if (!projectLanguages(stored).includes(languageCode)) {
    res.status(404).json({ error: `Project is not being dubbed into ${languageCode}` });
    return;
  }
  // The primary language's render is the one at the top level; the rest carry their own.
  const videoStoragePath =
    languageCode === stored.targetLanguage
      ? stored.finalDubbedVideoStoragePath
      : stored.languageOutputs?.[languageCode]?.finalDubbedVideoStoragePath;
  if (!videoStoragePath) {
    res.status(400).json({ error: `The ${getLanguageName(languageCode)} dub is not ready yet` });
    return;
  }

  const wantsCaptions = Boolean(req.body?.captions);
  if (!wantsCaptions) {
    res.json({ url: await getSignedDownloadUrl(videoStoragePath) });
    return;
  }
  const segments = segmentsForLanguage(stored, languageCode);
  if (!segments.length) {
    res.status(400).json({ error: 'No caption text available for this language' });
    return;
  }

  const captionedStoragePath = captionedStoragePathFor(workspaceId, projectId, languageCode);
  const [alreadyRendered] = await bucket.file(captionedStoragePath).exists();
  if (alreadyRendered) {
    res.json({ url: await getSignedDownloadUrl(captionedStoragePath) });
    return;
  }

  // Unique per request: two people downloading the same captions at once must not share scratch files.
  const jobDir = path.join(tmpDir, 'jobs', `${projectId}-captions-${languageCode}-${randomUUID()}`);
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireHeavySlot();
    await mkdir(jobDir, { recursive: true });
    const sourceLocalPath = path.join(jobDir, 'dubbed.mp4');
    await bucket.file(videoStoragePath).download({ destination: sourceLocalPath });

    const assPath = path.join(jobDir, 'captions.ass');
    await writeFile(assPath, buildKaraokeAss(segments), 'utf8');

    const captionedLocalPath = path.join(jobDir, 'dubbed_captioned.mp4');
    await burnSubtitles(sourceLocalPath, assPath, captionedLocalPath);

    await uploadFileToStorage(captionedStoragePath, captionedLocalPath, 'video/mp4');
    res.json({ url: await getSignedDownloadUrl(captionedStoragePath) });
  } catch (err) {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: (err as Error).message });
  } finally {
    releaseSlot?.();
    await rm(jobDir, { recursive: true, force: true });
  }
});
