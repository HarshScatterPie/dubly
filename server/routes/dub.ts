import { Router } from 'express';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { bucket, getSignedDownloadUrl, invalidateSignedUrlCache, uploadFileToStorage } from '../lib/firebaseAdmin';
import {
  getSettings,
  getStoredProject,
  projectLanguages,
  recordCompletedDub,
  segmentsForLanguage,
  updateStoredProject,
  type StoredLanguageOutput,
  type StoredProject,
} from '../lib/projectRepo';
import { routeSynthesizeSpeech, type ProviderSettings } from '../lib/modelRouter';
import { burnSubtitles, muxVideoWithAudio, stitchDubbedAudio } from '../lib/ffmpeg';
import { buildKaraokeAss } from '../lib/captions';
import { isLipSyncAvailable, runLipSync } from '../lib/lipSync';
import { createCostMeter, recordTts, summarizeCost } from '../lib/costMeter';
import { isSeparationAvailable, separateBackground } from '../lib/audioSeparation';
import { getLanguageName } from '../lib/languageMeta';
import { resolveVoice, type VoiceSelection } from '../lib/voiceResolution';
import { createReferenceLoader, isClonedVoiceId, voiceCatalogFor } from '../lib/customVoices';
import { tmpDir } from '../lib/paths';
import { VOICES } from '../../src/data/mockData';
import type { LocalizedSegment } from '../../src/types';

export const dubRouter = Router();

dubRouter.post('/:id/dub', async (req, res) => {
  const uid = req.uid!;
  const projectId = req.params.id;
  const stored = await getStoredProject(uid, projectId);
  if (!stored || stored.ownerUid !== uid) {
    res.status(404).json({ error: 'Project not found' });
    return;
  }
  if (!stored.videoStoragePath) {
    res.status(400).json({ error: 'Upload a video before dubbing' });
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

  await updateStoredProject(uid, projectId, {
    status: 'processing',
    progressPercent: 5,
    currentProcessingMessage: 'Preparing dubbing pipeline...',
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

  res.status(202).json({ status: 'processing' });

  // Fire-and-forget: the client polls GET /api/projects/:id for progress instead of
  // waiting on this request, since a full render can take well over a minute.
  runDubPipeline(uid, projectId, onlyLanguages?.length ? onlyLanguages : undefined).catch(async (err) => {
    console.error('[dub] pipeline failed', err);
    await updateStoredProject(uid, projectId, {
      status: 'failed',
      currentProcessingMessage: (err as Error).message || 'Dubbing failed',
    }).catch(() => undefined);
  });
});

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
  uid: string,
  projectId: string,
  useSeparation: boolean
): Promise<{ path: string; isVocalsRemoved: boolean }> {
  if (useSeparation && isSeparationAvailable()) {
    await updateStoredProject(uid, projectId, {
      // Still inside the shared-setup slice of the bar: separation runs once for the whole
      // job, before any language starts rendering.
      progressPercent: 10,
      currentProcessingMessage: 'Separating background audio (music, applause) from speech...',
    });
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
  uid: string;
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
  onProgress: (fraction: number, message: string) => Promise<void>;
}): Promise<{ dubbedAudioStoragePath: string; finalDubbedVideoStoragePath: string }> {
  const { uid, projectId, stored, languageCode, segments, videoLocalPath, background, costMeter } = params;
  const languageName = getLanguageName(languageCode);
  // Each language renders in its own directory: the stitcher writes fixed filenames
  // (seg_0.wav, dubbed_audio.wav), so a shared directory would have each language
  // overwrite the one before it.
  const langDir = path.join(params.jobDir, languageCode);
  await mkdir(langDir, { recursive: true });

  const timedAudio: { startTime: number; endTime: number; audio: Buffer }[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    // A segment with no text (e.g. a silent lead-in the STT step correctly
    // transcribed as empty) has nothing to synthesize — every provider rejects an
    // empty string outright. Leave that span silent in the stitched track instead.
    if (seg.translatedText.trim().length > 0) {
      // Resolved per line, not once per render: the voice can differ by speaker as well
      // as by language, and both are only known here.
      const lineVoice = resolveVoice(params.voiceSelection, languageCode, seg.speaker, params.voiceCatalog);
      const { audio, provider, fromCache } = await routeSynthesizeSpeech(
        seg.translatedText,
        lineVoice,
        languageCode,
        params.ttsProvider,
        isClonedVoiceId(lineVoice.id) ? await params.loadCloneReference(lineVoice.id) : undefined
      );
      recordTts(costMeter, provider, seg.translatedText.length, fromCache);
      timedAudio.push({ startTime: seg.startTime, endTime: seg.endTime, audio });
    }
    await params.onProgress(
      segments.length ? ((i + 1) / segments.length) * 0.7 : 0.7,
      `${languageName}: generating neural voice audio (${i + 1}/${segments.length})...`
    );
  }

  await params.onProgress(0.75, `${languageName}: synchronizing dubbed audio timeline...`);
  const stitchedAudioPath = await stitchDubbedAudio({
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
  const dubbedAudioStoragePath = `users/${uid}/projects/${projectId}/dubbed_audio_${languageCode}.wav`;
  const finalDubbedVideoStoragePath = `users/${uid}/projects/${projectId}/dubbed_${languageCode}.mp4`;
  await uploadFileToStorage(dubbedAudioStoragePath, stitchedAudioPath, 'audio/wav');
  await uploadFileToStorage(finalDubbedVideoStoragePath, finalVideoPath, 'video/mp4');
  // A re-dub overwrites these same paths — drop any cached signed URL so the next
  // read mints a fresh one immediately instead of serving stale cached bytes.
  invalidateSignedUrlCache(dubbedAudioStoragePath);
  invalidateSignedUrlCache(finalDubbedVideoStoragePath);
  // Any captioned variant was burned from the *previous* render of this language, so it is
  // now stale — drop it and let the next captioned download rebuild it.
  const stalePath = captionedStoragePathFor(uid, projectId, languageCode);
  await bucket.file(stalePath).delete({ ignoreNotFound: true });
  invalidateSignedUrlCache(stalePath);

  return { dubbedAudioStoragePath, finalDubbedVideoStoragePath };
}

async function runDubPipeline(uid: string, projectId: string, onlyLanguages?: string[]): Promise<void> {
  const stored = await getStoredProject(uid, projectId);
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

  // A language with no translation behind it has nothing to render — skip it rather than
  // producing a video of the source text read aloud.
  const languages = projectLanguages(stored)
    .filter((code) => !onlyLanguages || onlyLanguages.includes(code))
    .filter((code) => segmentsForLanguage(stored, code).length > 0);
  if (languages.length === 0) throw new Error('Translate the video before dubbing');

  const jobDir = path.join(tmpDir, 'jobs', `${projectId}-dub`);
  await mkdir(jobDir, { recursive: true });
  const costMeter = createCostMeter();
  // One download per cloned voice for the whole render, not one per line.
  const loadCloneReference = createReferenceLoader(uid, jobDir);

  try {
    await updateStoredProject(uid, projectId, {
      progressPercent: 8,
      currentProcessingMessage: 'Preparing source audio...',
    });
    // Needed before stitching: the source audio becomes the bed the dub sits on, so
    // applause/music/ambience survive into the export instead of being replaced by silence.
    const videoLocalPath = path.join(jobDir, 'source.mp4');
    await bucket.file(stored.videoStoragePath!).download({ destination: videoLocalPath });

    const background = await prepareBackgroundBed(
      videoLocalPath,
      jobDir,
      uid,
      projectId,
      Boolean(stored.separateBackground)
    );

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
        await updateStoredProject(uid, projectId, {
          progressPercent: Math.min(99, Math.round(overall * 100)),
          currentProcessingMessage: languages.length > 1 ? `[${i + 1}/${languages.length}] ${message}` : message,
        });
      };

      try {
        const paths = await renderLanguage({
          uid,
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
          onProgress,
        });
        languageOutputs[languageCode] = {
          ...languageOutputs[languageCode],
          languageCode,
          localizedSegments: segments,
          status: 'completed',
          progressPercent: 100,
          message: undefined,
          wordsCount: segments.reduce((sum, s) => sum + s.translatedText.split(/\s+/).filter(Boolean).length, 0),
          ...paths,
        };
        if (languageCode === stored.targetLanguage) primaryPaths = paths;
      } catch (err) {
        // One language failing (no voice covers it, a provider outage mid-run) must not
        // throw away the languages that already rendered or the ones still queued behind.
        console.error(`[dub] ${languageCode} failed`, err);
        failures.push(getLanguageName(languageCode));
        languageOutputs[languageCode] = {
          ...languageOutputs[languageCode],
          languageCode,
          localizedSegments: segments,
          status: 'failed',
          progressPercent: 0,
          message: (err as Error).message || 'Dubbing failed',
        };
      }
      // Persisted after every language, so a finished one is downloadable immediately
      // instead of waiting on the ones still rendering.
      await updateStoredProject(uid, projectId, { languageOutputs });
    }

    const completed = languages.filter((code) => languageOutputs[code]?.status === 'completed');
    if (completed.length === 0) {
      throw new Error(`Dubbing failed for every language (${failures.join(', ')})`);
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
    await updateStoredProject(uid, projectId, {
      status: 'completed',
      currentStep: 'export',
      progressPercent: 100,
      targetLanguage: headlineLanguage,
      localizedSegments: segmentsForLanguage(stored, headlineLanguage),
      languageOutputs,
      ...headlinePaths,
      wordsCount,
      currentProcessingMessage: failures.length
        ? `Finished ${completed.length}/${languages.length} languages — failed: ${failures.join(', ')}`
        : undefined,
    });

    const fileSizeMb = Number((stored.videoFileSize || '0').replace(/[^0-9.]/g, '')) || 0;
    // Counted per rendered language: each is its own full TTS + render pass, so a
    // five-language project really does consume five dubs' worth of minutes and words.
    for (const languageCode of completed) {
      await recordCompletedDub(uid, {
        minutesAdded: stored.videoDuration / 60,
        wordsAdded: wordsCount,
        targetLanguageCode: languageCode,
        fileSizeMb,
      });
    }
  } finally {
    console.log(`[cost] dub ${projectId}: ${summarizeCost(costMeter)}`);
    await rm(jobDir, { recursive: true, force: true });
  }
}

/**
 * Where a language's burned-in-captions render is cached. One per language, because the
 * captions are that language's own translated text over that language's own video.
 */
function captionedStoragePathFor(uid: string, projectId: string, languageCode: string): string {
  return `users/${uid}/projects/${projectId}/dubbed_captioned_${languageCode}.mp4`;
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
dubRouter.post('/:id/export-video', async (req, res) => {
  const uid = req.uid!;
  const projectId = req.params.id;
  const stored = await getStoredProject(uid, projectId);
  if (!stored || stored.ownerUid !== uid) {
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

  const captionedStoragePath = captionedStoragePathFor(uid, projectId, languageCode);
  const [alreadyRendered] = await bucket.file(captionedStoragePath).exists();
  if (alreadyRendered) {
    res.json({ url: await getSignedDownloadUrl(captionedStoragePath) });
    return;
  }

  const jobDir = path.join(tmpDir, 'jobs', `${projectId}-captions-${languageCode}`);
  await mkdir(jobDir, { recursive: true });
  try {
    const sourceLocalPath = path.join(jobDir, 'dubbed.mp4');
    await bucket.file(videoStoragePath).download({ destination: sourceLocalPath });

    const assPath = path.join(jobDir, 'captions.ass');
    await writeFile(assPath, buildKaraokeAss(segments), 'utf8');

    const captionedLocalPath = path.join(jobDir, 'dubbed_captioned.mp4');
    await burnSubtitles(sourceLocalPath, assPath, captionedLocalPath);

    await uploadFileToStorage(captionedStoragePath, captionedLocalPath, 'video/mp4');
    res.json({ url: await getSignedDownloadUrl(captionedStoragePath) });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});
