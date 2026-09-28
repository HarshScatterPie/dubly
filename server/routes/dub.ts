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
  audioLeadSeconds,
  burnSubtitles,
  effectiveClipSeconds,
  embedSubtitleTrack,
  extractAudioForStt,
  loudnessTarget,
  MAX_COMPRESSION,
  measureLoudness,
  muxVideoWithAudio,
  normalizeLoudness,
  probeStreams,
  runFfmpeg,
  SAFE_INPUT_OPTIONS,
  SEGMENT_GUARD_SECONDS,
  TIMEOUT,
  type StreamLayout,
} from '../lib/ffmpeg';
import {
  mixDubAudio,
  planPlacements,
  renderVoiceTrack,
  STRICT_MAX_TEMPO,
  TAKE_LEAD_SECONDS,
  voiceTrackFor16k,
  type DuckSpan,
  type LineTiming,
} from '../lib/dubMix';
import { detectSpeechBounds, getWavDurationSeconds, openWavSlicer, speechLevelDb, type SpeechBounds, type WavSlicer } from '../lib/audioUtils';
import { describeVerdict, retakeStyle, reviewDubbedLines, type LineVerdict } from '../lib/dubDirector';
import { lineGainsDb } from '../lib/levelMatch';
import { stripPerformanceTags } from '../lib/performance';
import { planForWorkspace } from '../lib/plans';
import { allowanceRate, effectiveExtras, NO_EXTRAS, type PaidExtrasChoice } from '../../src/lib/planMath';
import { isVertexConfigured, vertexCondenseLine, vertexHinglishToSpeechScript } from '../lib/vertexClient';
import { buildKaraokeAss } from '../lib/captions';
import { toSrt } from '../../src/lib/captionCues';
import { isLipSyncAvailable, lipSyncFps, runLipSync } from '../lib/lipSync';
import { costEstimate, createCostMeter, recordTts, summarizeCost } from '../lib/costMeter';
import { isSeparationAvailable, SEPARATION_MODEL, separateStems } from '../lib/audioSeparation';
import { getLanguageName } from '../lib/languageMeta';
import { tmpDir } from '../lib/paths';
import { resolveVoice, type VoiceSelection } from '../lib/voiceResolution';
import { createReferenceLoader, isClonedVoiceId, voiceCatalogFor } from '../lib/customVoices';
import { VOICES } from '../../src/data/mockData';
import type { GlossaryEntry, LocalizedSegment, QaFlag, RenderReport, TranscriptSegment, Voice } from '../../src/types';
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
interface BackgroundBed {
  path: string;
  isVocalsRemoved: boolean;
  /** The original speaker alone, when separation ran: a clean reference for where and how loud they speak. */
  vocalsPath?: string;
}

// Identifies the exact upload the cached stems were made from; a re-upload lands on the same path, so size and length are part of it.
const sourceKey = (stored: StoredProject) => `${stored.videoStoragePath}|${stored.videoDuration}|${stored.videoFileSize}`;

// Calls `fn` with progress at most every few seconds and only on real movement, since each call is a Firestore write.
function throttled(fn: (fraction: number) => Promise<unknown>, minIntervalMs = 3000): (fraction: number) => void {
  let lastAt = 0;
  let lastValue = -1;
  return (fraction) => {
    const now = Date.now();
    if (now - lastAt < minIntervalMs || Math.abs(fraction - lastValue) < 0.02) return;
    lastAt = now;
    lastValue = fraction;
    void fn(fraction).catch(() => undefined);
  };
}

/**
 * Chooses what the dubbed voice sits on top of.
 *
 * Preferred: a vocals-removed stem, so the original soundtrack keeps playing continuously
 * underneath the dub. Its stems are cached in the project's storage, so a retake or another
 * language reuses them instead of running the (slow) separation again. Fallback: the
 * untouched source audio, which the mix then mutes only where the original speaker talks —
 * that still preserves applause and music between lines without the original voice.
 */
async function prepareBackgroundBed(
  job: DubJob,
  stored: StoredProject,
  videoLocalPath: string,
  jobDir: string,
  useSeparation: boolean
): Promise<BackgroundBed> {
  const raw: BackgroundBed = { path: videoLocalPath, isVocalsRemoved: false };
  if (!useSeparation) return raw;

  const cache = stored.stemsCache;
  if (cache && cache.sourcePath === sourceKey(stored) && cache.model === SEPARATION_MODEL) {
    try {
      await writeProjectForJob(job, { progressPercent: 10, currentProcessingMessage: 'Reusing the separated background audio...' }, { stage: 'separating_audio', progress: 10 });
      const background = path.join(jobDir, 'stem_background.m4a');
      const vocals = path.join(jobDir, 'stem_vocals.m4a');
      await Promise.all([
        bucket.file(cache.backgroundPath).download({ destination: background }),
        bucket.file(cache.vocalsPath).download({ destination: vocals }),
      ]);
      return { path: background, isVocalsRemoved: true, vocalsPath: vocals };
    } catch (err) {
      if (err instanceof JobCancelledError || err instanceof JobSupersededError) throw err;
      log.warn('stems_cache_miss', { error: (err as Error).message });
    }
  }
  if (!isSeparationAvailable()) return raw;

  // Still inside the shared-setup slice of the bar: separation runs once for the whole job, before any language renders.
  const message = 'Separating background audio (music, applause) from speech';
  await writeProjectForJob(job, { progressPercent: 10, currentProcessingMessage: `${message}...` }, { stage: 'separating_audio', progress: 10 });
  const report = throttled((fraction) =>
    writeProjectForJob(
      job,
      { progressPercent: 10 + Math.round(fraction * 4), currentProcessingMessage: `${message} — ${Math.round(fraction * 100)}%` },
      { stage: 'separating_audio', progress: 10 + Math.round(fraction * 4) }
    )
  );
  const stems = await separateStems(videoLocalPath, jobDir, { durationSeconds: stored.videoDuration, onProgress: report });
  if (!stems) {
    log.warn('separation_failed', {}, '[dub] separation unavailable/failed, keeping background via ducking instead');
    return raw;
  }

  // Cached as AAC (a fraction of the WAV size, transparent for a music bed); a failure here only costs the next run the separation.
  try {
    const background = path.join(jobDir, 'stem_background_cache.m4a');
    const vocals = path.join(jobDir, 'stem_vocals_cache.m4a');
    await Promise.all([
      runFfmpeg([...SAFE_INPUT_OPTIONS, '-i', stems.background, '-c:a', 'aac', '-b:a', '256k', '-y', background], TIMEOUT.render),
      runFfmpeg([...SAFE_INPUT_OPTIONS, '-i', stems.vocals, '-c:a', 'aac', '-b:a', '128k', '-y', vocals], TIMEOUT.render),
    ]);
    const prefix = `workspaces/${job.workspaceId}/projects/${job.projectId}/stems/${SEPARATION_MODEL}`;
    const stemsCache = { sourcePath: sourceKey(stored), model: SEPARATION_MODEL, backgroundPath: `${prefix}_background.m4a`, vocalsPath: `${prefix}_vocals.m4a` };
    await Promise.all([
      uploadFileToStorage(stemsCache.backgroundPath, background, 'audio/mp4'),
      uploadFileToStorage(stemsCache.vocalsPath, vocals, 'audio/mp4'),
    ]);
    await writeProjectForJob(job, { stemsCache });
  } catch (err) {
    if (err instanceof JobCancelledError || err instanceof JobSupersededError) throw err;
    log.warn('stems_cache_write_failed', { error: (err as Error).message });
  }
  return { path: stems.background, isVocalsRemoved: true, vocalsPath: stems.vocals };
}

/** Joins overlapping or touching spans. */
function mergeSpans(spans: { start: number; end: number }[], gap = 0): { start: number; end: number }[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end + gap) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/**
 * How the background bed moves under the dub, as smooth gain ramps rather than on/off switches.
 *
 * A raw source bed still carries the original speaker, so it is muted wherever they talk,
 * with a margin (line edges are approximate, and any leak is the original voice audible
 * alongside the dub). A vocals-removed stem has no voice to hide; it only dips gently under
 * the dub (and under any residue separation left), so the music keeps breathing.
 */
function bedSpans(original: { start: number; end: number }[], dub: { start: number; end: number }[], isVocalsRemoved: boolean): DuckSpan[] {
  if (isVocalsRemoved) {
    return mergeSpans([...original, ...dub], 0.4).map((s) => ({ ...s, level: 0.5, attack: 0.15, release: 0.4 }));
  }
  const muted = mergeSpans(original.map((s) => ({ start: Math.max(0, s.start - 0.12), end: s.end + 0.2 })), 0.15).map((s) => ({
    ...s,
    level: 0,
    attack: 0.05,
    release: 0.1,
  }));
  const under = mergeSpans(dub, 0.4).map((s) => ({ ...s, level: 0.45, attack: 0.12, release: 0.35 }));
  return [...muted, ...under];
}

/**
 * Where each original line's speech really starts and stops, measured once per job and
 * shared by every language (see detectSpeechBounds). Keyed by transcript segment id.
 */
async function measureSpeechBounds(segments: TranscriptSegment[], speech: WavSlicer | null): Promise<Map<string, SpeechBounds>> {
  const found = new Map<string, SpeechBounds>();
  if (!speech) return found;
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    const from = Math.max(0, seg.startTime - 0.4);
    const clip = await speech.slice(from, seg.endTime + 0.4);
    const bounds = clip ? detectSpeechBounds(clip, from, { start: seg.startTime, end: seg.endTime }) : null;
    if (bounds && (bounds.onset !== null || bounds.offset !== null)) found.set(seg.id, bounds);
  }
  return found;
}

/**
 * Line levels are read from a mono downmix of the original, while the dub's voice is laid
 * into both stereo channels at full level. This is the difference between the two, so a
 * voice matched on the downmix plays exactly as loud as the original speaker did.
 */
const DOWNMIX_CALIBRATION_DB = 0;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
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
  background: BackgroundBed;
  jobDir: string;
  costMeter: ReturnType<typeof createCostMeter>;
  voiceSelection: VoiceSelection;
  voiceCatalog: (typeof VOICES)[number][];
  loadCloneReference: (voiceId: string) => Promise<{ audioPath: string; transcript?: string }>;
  ttsProvider: ProviderSettings['ttsProvider'];
  expressiveVoices: boolean;
  glossary: GlossaryEntry[];
  // The original's audio (16 kHz), which the AI review compares each take with; null when it could not be extracted.
  sourceSpeech: WavSlicer | null;
  // The cleanest record of the original speaker (the vocals stem when separated, else the same track): per-line levels.
  levelSpeech: WavSlicer | null;
  // Measured start/end of each original line's speech, by transcript segment id.
  speechBounds: Map<string, SpeechBounds>;
  // A face is on screen or lip-sync is on: fit each line to the speaker's mouth, not just to the gap before the next line.
  strictSync: boolean;
  // The source's streams: frame rate for lip-sync, and how far its sound is offset from its picture.
  layout: StreamLayout | null;
  // The paid extras the user who started the dub switched on (Settings): AI review, premium voices, pace re-takes.
  aiReview: boolean;
  premiumVoices: boolean;
  paceRetakes: boolean;
  // Integrated loudness (LUFS) the finished track is levelled to, taken from the original; null skips levelling.
  loudnessLufs: number | null;
  onProgress: (fraction: number, message: string) => Promise<void>;
}): Promise<{ paths: { dubbedAudioStoragePath: string; finalDubbedVideoStoragePath: string }; segments: LocalizedSegment[]; report: RenderReport }> {
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
      // With lip-sync on, the line has to fit the speaker's mouth, not merely the gap before the next line.
      const bounds = params.speechBounds.get(seg.segmentId);
      const mouthSlot = Math.max(0.2, (bounds?.offset ?? seg.endTime) - (bounds?.onset ?? seg.startTime));
      const fitLimit = stored.autoLipSync ? Math.min(available * MAX_COMPRESSION, mouthSlot * STRICT_MAX_TEMPO * 1.06) : available * MAX_COMPRESSION;
      const fitTarget = stored.autoLipSync ? Math.min(available, mouthSlot * 1.12) : available;
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
      if (!seg.isEdited && spokenSeconds > fitLimit) {
        try {
          const condensed = await vertexCondenseLine(seg.translatedText, languageCode, languageName, fitTarget * 1.1, spokenSeconds, protectedTerms);
          if (condensed) {
            const condensedSpeech = isHinglish
              ? (await vertexHinglishToSpeechScript([{ id: seg.id, text: condensed }]))[seg.id] || condensed
              : condensed;
            const retake = await synthesizeLine(condensedSpeech, voice, cloneReference, style);
            if (getWavDurationSeconds(retake.audio) < getWavDurationSeconds(audio)) {
              console.log(`[dub] ${languageCode} ${seg.id}: condensed to fit ${fitTarget.toFixed(1)}s slot (was ${spokenSeconds.toFixed(1)}s)`);
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
    const sliceOf = (speech: WavSlicer | null, t: LineTake) =>
      speech?.slice(finalSegments[t.index].startTime, finalSegments[t.index].endTime) ?? Promise.resolve(null);
    const originals = await Promise.all(group.map((t) => sliceOf(params.sourceSpeech, t)));
    // Levels come from the vocals stem when there is one: music under a line would otherwise read as a louder speaker.
    const levelClips = params.levelSpeech === params.sourceSpeech ? originals : await Promise.all(group.map((t) => sliceOf(params.levelSpeech, t)));
    group.forEach((t, k) => (t.sourceDb = levelClips[k] ? speechLevelDb(levelClips[k]!) : null));
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
  // ...and the voice as a whole as loud against the soundtrack as the original speaker was, so music between lines keeps its old balance.
  const levelPairs = takes
    .map((t) => ({ source: t.sourceDb, dub: speechLevelDb(t.audio) }))
    .filter((p): p is { source: number; dub: number } => p.source !== null && p.dub !== null);
  const sourceMid = median(levelPairs.map((p) => p.source));
  const dubMid = median(levelPairs.map((p) => p.dub));
  const voiceGainDb = levelPairs.length >= 3 && sourceMid !== null && dubMid !== null ? Math.max(-10, Math.min(10, sourceMid - dubMid + DOWNMIX_CALIBRATION_DB)) : 0;

  // Where each take lands: on the original speaker's measured onset (so the voice never arrives before the lips),
  // paced to the mouth when a face is on screen, and never into the next line.
  const timings: LineTiming[] = takes.map((t) => {
    const seg = finalSegments[t.index];
    const bounds = params.speechBounds.get(seg.segmentId);
    return {
      start: bounds?.onset != null ? Math.max(0, bounds.onset - TAKE_LEAD_SECONDS) : seg.startTime,
      end: bounds?.offset ?? seg.endTime,
      rawSeconds: getWavDurationSeconds(t.audio),
    };
  });
  const placements = planPlacements(timings, { totalSeconds: stored.videoDuration, speed: stored.voiceSpeed, strict: params.strictSync });
  const placedByIndex = new Map(takes.map((t, k) => [t.index, { placement: placements[k], timing: timings[k] }]));

  const report: RenderReport = {
    lipSync: stored.autoLipSync ? 'failed' : 'off',
    background: background.isVocalsRemoved ? 'separated' : 'ducked',
    channels: 'stereo',
    lines: takes.length,
    inSync: 0,
    condensed: 0,
    rushed: 0,
    overflow: 0,
    onsetsSnapped: takes.filter((t) => params.speechBounds.get(finalSegments[t.index].segmentId)?.onset != null).length,
    renderedAt: new Date().toISOString(),
  };
  const round3 = (n: number) => Math.round(n * 1000) / 1000;
  const takeByIndex = new Map(takes.map((t) => [t.index, t]));
  for (let i = 0; i < finalSegments.length; i++) {
    const { dubStartTime: _oldStart, dubEndTime: _oldEnd, ...seg } = finalSegments[i];
    const take = takeByIndex.get(i);
    const placed = placedByIndex.get(i);
    const renderFlags: QaFlag[] = take
      ? [
          ...renderQaFlags({ condensed: take.condensed, spokenSeconds: playedSeconds(take.audio), availableSeconds: take.available, maxCompression: MAX_COMPRESSION }),
          ...(take.directorNote ? (['director'] as QaFlag[]) : []),
        ]
      : [];
    let spokenAt: Pick<LocalizedSegment, 'dubStartTime' | 'dubEndTime'> = {};
    if (take && placed) {
      const { placement, timing } = placed;
      const dubEnd = placement.start + placement.playedSeconds;
      const mouthSlot = Math.max(0.2, timing.end - timing.start);
      if (Math.abs(dubEnd - timing.end) <= Math.max(0.3, mouthSlot * 0.15)) report.inSync++;
      // The take's own lead-in and tail are silence, so captions start and stop with the sound itself.
      spokenAt = { dubStartTime: round3(placement.start + TAKE_LEAD_SECONDS), dubEndTime: round3(placement.start + Math.max(0.25, placement.playedSeconds - 0.06)) };
    }
    if (renderFlags.includes('condensed')) report.condensed++;
    if (renderFlags.includes('rushed')) report.rushed++;
    if (renderFlags.includes('overflow')) report.overflow++;
    // Every line, spoken or silent, records what was rendered, so a later retake can tell exactly which lines changed.
    finalSegments[i] = withFlags(
      { ...seg, ...spokenAt, renderKey: currentLineKey(stored, languageCode, seg), ...(take?.directorNote ? { directorNote: take.directorNote } : {}) },
      [...textQaFlags(seg, review), ...renderFlags]
    );
  }

  await params.onProgress(0.72, `${languageName}: synchronizing every line to the speaker's timing...`);
  const voicePath = path.join(langDir, 'voice.wav');
  await renderVoiceTrack(
    takes.map((t, k) => ({ audio: t.audio, start: placements[k].start, tempo: placements[k].tempo, gainDb: gains.get(finalSegments[t.index].id) })),
    { totalSeconds: stored.videoDuration, pitch: stored.voicePitch, outputPath: voicePath }
  );

  await params.onProgress(0.77, `${languageName}: synchronizing the voice with the soundtrack...`);
  // Every line the original speaker talks in, spoken in the dub or not: an untranslated line still has their voice under it.
  const originalSpans = segments.map((s) => {
    const bounds = params.speechBounds.get(s.segmentId);
    return { start: Math.min(s.startTime, bounds?.onset ?? Infinity), end: Math.max(s.endTime, bounds?.offset ?? -Infinity) };
  });
  const dubSpans = placements.map((p) => ({ start: p.start, end: p.start + p.playedSeconds }));
  let stitchedAudioPath = await mixDubAudio({
    voicePath,
    totalSeconds: stored.videoDuration,
    outputPath: path.join(langDir, 'dubbed_audio.wav'),
    workDir: langDir,
    voiceGainDb,
    bed: { path: background.path, spans: bedSpans(originalSpans, dubSpans, background.isVocalsRemoved) },
  });

  // As loud as the original, measured the way streaming platforms measure it, so the dub never plays quieter or louder than the source did.
  if (params.loudnessLufs !== null) {
    await params.onProgress(0.8, `${languageName}: matching loudness to the original...`);
    const leveledPath = path.join(langDir, 'dubbed_audio_leveled.wav');
    if (await normalizeLoudness(stitchedAudioPath, leveledPath, params.loudnessLufs)) stitchedAudioPath = leveledPath;
  }

  await params.onProgress(0.82, `${languageName}: rendering final dubbed master video...`);
  // Positive when the source's sound starts after its picture; transcript times count from the first sound, so the dub starts that much later too.
  const audioLead = audioLeadSeconds(params.layout);
  let finalVideoPath = path.join(langDir, 'dubbed.mp4');
  await muxVideoWithAudio(videoLocalPath, stitchedAudioPath, finalVideoPath, { audioOffsetSeconds: Math.max(0, audioLead), languageCode });

  if (stored.autoLipSync) {
    if (!isLipSyncAvailable()) report.lipSync = 'unavailable';
    else if (stored.faceScan && !stored.faceScan.hasFaces) report.lipSync = 'skipped_no_face';
    else {
      const lipSyncMessage = `${languageName}: lip-syncing the speaker's mouth to the new voice`;
      await params.onProgress(0.84, `${lipSyncMessage}...`);
      try {
        const voice16k = await voiceTrackFor16k(voicePath, path.join(langDir, 'voice_16k.wav'));
        const lipSyncVideo = path.join(langDir, 'lipsync_video.mp4');
        const result = await runLipSync({
          videoPath: videoLocalPath,
          voiceWavPath: voice16k,
          outputPath: lipSyncVideo,
          fps: lipSyncFps(params.layout?.video?.fps ?? 0),
          durationSeconds: stored.videoDuration,
          spans: mergeSpans([...originalSpans, ...dubSpans], 0.3),
          workDir: langDir,
          onProgress: throttled((fraction) => params.onProgress(0.84 + fraction * 0.1, `${lipSyncMessage} — ${Math.round(fraction * 100)}%`), 4000),
        });
        if (result.synced === 0) {
          report.lipSync = 'skipped_no_face';
        } else {
          const lipSyncedPath = path.join(langDir, 'dubbed_lipsynced.mp4');
          // The lip-synced picture starts at the source's first frame, so an offset either way is applied here.
          await muxVideoWithAudio(lipSyncVideo, stitchedAudioPath, lipSyncedPath, { audioOffsetSeconds: audioLead, languageCode });
          finalVideoPath = lipSyncedPath;
          report.lipSync = 'applied';
        }
        log.info('lipsync_done', { languageCode, frames: result.frames, synced: result.synced });
      } catch (err) {
        if (err instanceof JobCancelledError || err instanceof JobSupersededError) throw err;
        // Best-effort enhancement, not a core requirement: fall back to the non-lip-synced render rather than failing the dub.
        log.error('lipsync_failed', err, { languageCode }, '[dub] lip-sync failed, continuing with non-lip-synced video');
        report.lipSync = 'failed';
      }
    }
  }

  // The captions ride along as a subtitle track viewers can switch on, so every download has them.
  const spokenLines = finalSegments.filter((s) => stripPerformanceTags(s.translatedText).trim());
  if (spokenLines.length) {
    try {
      const srtPath = path.join(langDir, 'captions.srt');
      await writeFile(srtPath, toSrt(spokenLines), 'utf8');
      const withCaptions = path.join(langDir, 'dubbed_cc.mp4');
      await embedSubtitleTrack(finalVideoPath, srtPath, withCaptions, languageCode);
      finalVideoPath = withCaptions;
    } catch (err) {
      log.warn('subtitle_track_failed', { languageCode, error: (err as Error).message });
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
  for (let version = 1; version <= CAPTIONS_VERSION; version++) {
    const stalePath = captionedStoragePathFor(workspaceId, projectId, languageCode, version);
    await bucket.file(stalePath).delete({ ignoreNotFound: true });
    invalidateSignedUrlCache(stalePath);
  }

  return { paths: { dubbedAudioStoragePath, finalDubbedVideoStoragePath }, segments: finalSegments, report };
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
  let vocalsSpeech: WavSlicer | null = null;

  try {
    await writeProjectForJob(job, { progressPercent: 8, currentProcessingMessage: 'Preparing source audio...' }, { stage: 'preparing_audio', progress: 8 });
    // Needed before stitching: the source audio becomes the bed the dub sits on, so
    // applause/music/ambience survive into the export instead of being replaced by silence.
    const videoLocalPath = path.join(jobDir, 'source.mp4');
    await bucket.file(stored.videoStoragePath!).download({ destination: videoLocalPath });
    const layout = await probeStreams(videoLocalPath).catch(() => null);

    const background = await prepareBackgroundBed(job, stored, videoLocalPath, jobDir, Boolean(stored.separateBackground));

    // Shared by every language: the original's speech (per-line levels, onsets, AI review) and its loudness. All are refinements, so failures are logged, not fatal.
    // Exactly the extras this dub was charged for when it started; jobs from before plans had none.
    const extras = job.extras ?? NO_EXTRAS;
    const aiReview = extras.aiReview && isVertexConfigured();
    const { premiumVoices, paceRetakes } = extras;
    const openSpeech = (input: string, output: string) =>
      extractAudioForStt(input, output)
        .then(() => openWavSlicer(output))
        .catch((err) => {
          console.error(`[dub] could not extract ${path.basename(output)}; lines keep their synthesized levels`, err);
          return null;
        });
    sourceSpeech = await openSpeech(videoLocalPath, path.join(jobDir, 'source_speech.wav'));
    // The vocals stem is the original speaker with the music taken out: exact onsets and honest levels.
    vocalsSpeech = background.vocalsPath ? await openSpeech(background.vocalsPath, path.join(jobDir, 'vocals_speech.wav')) : null;
    const levelSpeech = vocalsSpeech ?? sourceSpeech;
    await writeProjectForJob(job, { progressPercent: 14, currentProcessingMessage: 'Measuring where every line is spoken...' }, { stage: 'measuring_speech', progress: 14 });
    const speechBounds = await measureSpeechBounds(stored.transcriptSegments || [], levelSpeech);
    const sourceLoudness = await measureLoudness(videoLocalPath);
    const loudnessLufs = loudnessTarget(sourceLoudness);
    // A face on screen means viewers watch the mouth: fit every line to it, not only to the gap before the next line.
    const strictSync = Boolean(stored.autoLipSync) || stored.faceScan?.hasFaces === true;
    log.info('dub_setup', {
      separated: background.isVocalsRemoved,
      onsetsMeasured: speechBounds.size,
      lines: stored.transcriptSegments?.length ?? 0,
      strictSync,
      audioLead: audioLeadSeconds(layout),
      fps: layout?.video?.fps,
    });

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
        const { paths, segments: renderedSegments, report } = await renderLanguage({
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
          levelSpeech,
          speechBounds,
          strictSync,
          layout,
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
          renderReport: report,
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
    await vocalsSpeech?.close().catch(() => undefined);
    await rm(jobDir, { recursive: true, force: true });
  }
}

/**
 * Where a language's burned-in-captions render is cached. One per language, because the
 * captions are that language's own translated text over that language's own video.
 */
function captionedStoragePathFor(workspaceId: string, projectId: string, languageCode: string, version = CAPTIONS_VERSION): string {
  return `workspaces/${workspaceId}/projects/${projectId}/dubbed_captioned${version > 1 ? `_v${version}` : ''}_${languageCode}.mp4`;
}

// Bumped when burned captions change look or fix a fault, so renders cached under the old name are never served again.
// v2: fonts are found at all (before, captions could burn in blank), sized to the video, timed to the dubbed voice.
// v3: the app bundles its caption fonts, so renders made on a host without Indic/Arabic fonts are redrawn.
const CAPTIONS_VERSION = 3;

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

  const state = await captionedExportState(workspaceId, projectId, languageCode, videoStoragePath, segments, true);
  if (state.status === 'ready') res.json({ url: state.url, status: state.status });
  else if (state.status === 'failed') res.status(500).json({ error: state.error, code: 'CAPTIONS_FAILED' });
  else res.status(202).json(state);
});

// Polled while a captioned render runs; separate from the POST so polling never spends the export rate limit.
dubRouter.get('/:id/export-video/captions', async (req, res) => {
  const workspaceId = req.workspaceId!;
  const projectId = req.params.id;
  const stored = await getStoredProject(workspaceId, projectId);
  if (!stored) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  const languageCode = typeof req.query.languageCode === 'string' && req.query.languageCode ? req.query.languageCode : stored.targetLanguage;
  const videoStoragePath =
    languageCode === stored.targetLanguage ? stored.finalDubbedVideoStoragePath : stored.languageOutputs?.[languageCode]?.finalDubbedVideoStoragePath;
  if (!projectLanguages(stored).includes(languageCode) || !videoStoragePath) {
    res.status(404).json({ error: 'This dub is not ready yet' });
    return;
  }
  res.json(await captionedExportState(workspaceId, projectId, languageCode, videoStoragePath, segmentsForLanguage(stored, languageCode), false));
});

type CaptionedState = { status: 'ready'; url: string } | { status: 'rendering' } | { status: 'failed'; error: string };

// Captioned renders in progress (or just failed) on this server, by storage path.
const captionRenders = new Map<string, { promise: Promise<void>; error?: string; failedAt?: number }>();

/**
 * Where a language's captioned video stands, starting its render when asked to and none is
 * running. The render re-encodes the whole video, which on a long dub takes longer than a
 * proxy will hold a request open — so it runs in the background and the client polls,
 * instead of the download failing with a gateway timeout.
 */
async function captionedExportState(
  workspaceId: string,
  projectId: string,
  languageCode: string,
  videoStoragePath: string,
  segments: LocalizedSegment[],
  start: boolean
): Promise<CaptionedState> {
  const captionedStoragePath = captionedStoragePathFor(workspaceId, projectId, languageCode);
  const running = captionRenders.get(captionedStoragePath);
  if (running?.error) {
    captionRenders.delete(captionedStoragePath);
    return { status: 'failed', error: running.error };
  }
  if (running) return { status: 'rendering' };
  const [alreadyRendered] = await bucket.file(captionedStoragePath).exists();
  if (alreadyRendered) return { status: 'ready', url: await getSignedDownloadUrl(captionedStoragePath) };
  if (!start) return { status: 'failed', error: 'No captioned render is in progress. Start the download again.' };

  const entry: { promise: Promise<void>; error?: string } = { promise: Promise.resolve() };
  entry.promise = renderCaptionedVideo(videoStoragePath, captionedStoragePath, segments, `${projectId}-captions-${languageCode}`)
    .then(() => {
      captionRenders.delete(captionedStoragePath);
    })
    .catch((err) => {
      log.error('captions_render_failed', err, { projectId, languageCode });
      entry.error = err instanceof HttpError ? err.message : 'Adding captions failed. Please try again.';
      // A failure is reported to the next poll, then forgotten so a retry starts afresh.
      setTimeout(() => captionRenders.get(captionedStoragePath) === entry && captionRenders.delete(captionedStoragePath), 10 * 60_000).unref();
    });
  captionRenders.set(captionedStoragePath, entry);
  void trackBackgroundWork(entry.promise);
  return { status: 'rendering' };
}

async function renderCaptionedVideo(videoStoragePath: string, captionedStoragePath: string, segments: LocalizedSegment[], label: string): Promise<void> {
  // Unique per render: scratch files are never shared.
  const jobDir = path.join(tmpDir, 'jobs', `${label}-${randomUUID()}`);
  let releaseSlot: (() => void) | undefined;
  try {
    releaseSlot = await acquireHeavySlot();
    await mkdir(jobDir, { recursive: true });
    const sourceLocalPath = path.join(jobDir, 'dubbed.mp4');
    await bucket.file(videoStoragePath).download({ destination: sourceLocalPath });

    // Laid out in the video's own pixels, so captions are the same size on a vertical short as on a landscape talk.
    const layout = await probeStreams(sourceLocalPath).catch(() => null);
    const assPath = path.join(jobDir, 'captions.ass');
    await writeFile(
      assPath,
      buildKaraokeAss(segments, layout?.video?.width && layout.video.height ? { width: layout.video.width, height: layout.video.height } : undefined),
      'utf8'
    );

    const captionedLocalPath = path.join(jobDir, 'dubbed_captioned.mp4');
    await burnSubtitles(sourceLocalPath, assPath, captionedLocalPath);
    await uploadFileToStorage(captionedStoragePath, captionedLocalPath, 'video/mp4');
    invalidateSignedUrlCache(captionedStoragePath);
  } finally {
    releaseSlot?.();
    await rm(jobDir, { recursive: true, force: true });
  }
}
