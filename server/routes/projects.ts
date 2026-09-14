import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, rm, stat } from 'node:fs/promises';
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
import { downloadToFile, extractAudioForStt, extractThumbnail, probeMedia } from '../lib/ffmpeg';
import { routeTranscribe, routeTranslateSegments } from '../lib/modelRouter';
import { alignSegmentsToSpeech, detectSpeechRegions, retimeWords } from '../lib/forcedAlign';
import { isCtcAlignAvailable, refineTimingsWithCtc } from '../lib/ctcAlign';
import { describeTranscriptHealth, sanitizeTranscript } from '../lib/transcriptSanitizer';
import { createCostMeter, recordStt, summarizeCost } from '../lib/costMeter';
import { getLanguageName, mapDetectedLanguageToAppCode, resolveTargetLanguages } from '../lib/languageMeta';
import { mapWithConcurrency } from '../lib/concurrency';
import { tmpDir } from '../lib/paths';
import { VOICES } from '../../src/data/mockData';
import type { LocalizedSegment, TranscriptSegment } from '../../src/types';

/**
 * Auto-assigns a distinct voice per detected speaker so a multi-speaker dub sounds like
 * multiple people out of the box, with zero user effort — alternates gender across the
 * catalog for maximum perceived variety, and skips voices already handed out.
 */
function assignVoicesToSpeakers(speakers: string[]): Record<string, string> {
  const male = VOICES.filter((v) => v.gender === 'male');
  const female = VOICES.filter((v) => v.gender === 'female');
  const rest = VOICES.filter((v) => v.gender !== 'male' && v.gender !== 'female');
  const rotation: typeof VOICES = [];
  const maxLen = Math.max(male.length, female.length);
  for (let i = 0; i < maxLen; i++) {
    if (male[i]) rotation.push(male[i]);
    if (female[i]) rotation.push(female[i]);
  }
  rotation.push(...rest);

  const map: Record<string, string> = {};
  speakers.forEach((speaker, i) => {
    map[speaker] = rotation[i % rotation.length]?.id || VOICES[0].id;
  });
  return map;
}

/**
 * Derives speaker count and per-speaker voice assignments from labels the transcription
 * step already returned.
 *
 * This deliberately does no extra model call. Speaker labels used to come from a separate
 * diarization pass that re-uploaded the whole audio to Gemini, which roughly doubled the
 * (audio-token priced) cost of analyzing a video. The transcription prompt now returns
 * the labels itself, so multi-speaker detection is effectively free.
 */
function resolveSpeakers(segments: TranscriptSegment[]): {
  segments: TranscriptSegment[];
  speakersCount: number;
  speakerVoiceMap: Record<string, string>;
} {
  if (segments.length === 0) {
    return { segments, speakersCount: 1, speakerVoiceMap: {} };
  }
  const distinct = Array.from(new Set(segments.map((s) => s.speaker || 'Speaker 1'))).sort();
  return {
    segments,
    speakersCount: distinct.length,
    speakerVoiceMap: distinct.length > 1 ? assignVoicesToSpeakers(distinct) : {},
  };
}

export const projectsRouter = Router();

const uploadDir = path.join(tmpDir, 'uploads');
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
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^video\//.test(file.mimetype) && !/\.(mp4|mov|webm)$/i.test(file.originalname)) {
      cb(new Error('Only video files (mp4/mov/webm) are accepted'));
      return;
    }
    cb(null, true);
  },
});

async function requireProject(uid: string, id: string) {
  const stored = await getStoredProject(uid, id);
  if (!stored || stored.ownerUid !== uid) return null;
  return stored;
}

projectsRouter.post('/', async (req, res) => {
  const { title, sourceLanguage, targetLanguage } = req.body || {};
  const project = await createProject(req.uid!, {
    title: title || 'Untitled Dub',
    sourceLanguage,
    targetLanguage,
  });
  res.status(201).json(await toClientProject(project));
});

projectsRouter.get('/', async (req, res) => {
  const projects = await listStoredProjects(req.uid!);
  res.json(await Promise.all(projects.map(toClientProject)));
});

projectsRouter.get('/:id', async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });
  res.json(await toClientProject(stored));
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

projectsRouter.patch('/:id', async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const patch: Record<string, unknown> = {};
  for (const field of PATCHABLE_FIELDS) {
    if (field in (req.body || {})) patch[field] = req.body[field];
  }
  const updated = await updateStoredProject(req.uid!, req.params.id, patch);
  res.json(await toClientProject(updated));
});

projectsRouter.delete('/:id', async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const storagePaths = [
    stored.videoStoragePath,
    stored.dubbedAudioStoragePath,
    stored.finalDubbedVideoStoragePath,
    stored.videoThumbnailStoragePath,
    // Every extra language's render lives at its own path, so deleting a project has to
    // sweep those too or they linger in the bucket with nothing pointing at them.
    ...Object.values(stored.languageOutputs || {}).flatMap((out) => [
      out.dubbedAudioStoragePath,
      out.finalDubbedVideoStoragePath,
    ]),
  ].filter((p): p is string => Boolean(p));
  await Promise.all(storagePaths.map((p) => bucket.file(p).delete({ ignoreNotFound: true })));
  storagePaths.forEach(invalidateSignedUrlCache);
  await deleteStoredProject(req.uid!, req.params.id);
  res.status(204).send();
});

async function ingestSourceVideo(uid: string, projectId: string, localVideoPath: string, fileName: string, fileSizeBytes: number) {
  const probe = await probeMedia(localVideoPath);
  const storagePath = `users/${uid}/projects/${projectId}/source${path.extname(fileName) || '.mp4'}`;
  await uploadFileToStorage(storagePath, localVideoPath, 'video/mp4');

  const resolution = probe.width && probe.height ? `${probe.width} × ${probe.height} (${probe.height >= 1080 ? 'Full HD' : probe.height >= 720 ? 'HD' : 'SD'})` : 'Unknown';
  const sizeMb = fileSizeBytes / (1024 * 1024);

  let videoThumbnailStoragePath: string | undefined;
  if (probe.width && probe.height) {
    try {
      const thumbLocalPath = path.join(path.dirname(localVideoPath), `${randomUUID()}.jpg`);
      await extractThumbnail(localVideoPath, thumbLocalPath, probe.durationSeconds * 0.1, probe.durationSeconds);
      const thumbStoragePath = `users/${uid}/projects/${projectId}/thumbnail.jpg`;
      await uploadFileToStorage(thumbStoragePath, thumbLocalPath, 'image/jpeg');
      videoThumbnailStoragePath = thumbStoragePath;
      await rm(thumbLocalPath, { force: true });
    } catch {
      // Thumbnail is cosmetic — fall back to the placeholder icon rather than failing the upload.
    }
  }

  return updateStoredProject(uid, projectId, {
    videoStoragePath: storagePath,
    videoThumbnailStoragePath,
    videoFileName: fileName,
    videoDuration: probe.durationSeconds,
    videoResolution: resolution,
    videoFileSize: `${sizeMb.toFixed(1)} MB`,
    status: 'draft',
  });
}

projectsRouter.post('/:id/upload', upload.single('file'), async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded' });

  try {
    const updated = await ingestSourceVideo(req.uid!, req.params.id, req.file.path, req.file.originalname, req.file.size);
    res.json(await toClientProject(updated));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await rm(req.file.path, { force: true });
  }
});

projectsRouter.post('/:id/import-sample', async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const { sourceUrl, fileName } = req.body || {};
  if (!sourceUrl) return res.status(400).json({ error: 'sourceUrl is required' });

  const localPath = path.join(uploadDir, `${randomUUID()}.mp4`);
  try {
    await downloadToFile(sourceUrl, localPath);
    const { size } = await stat(localPath);
    const updated = await ingestSourceVideo(req.uid!, req.params.id, localPath, fileName || 'sample.mp4', size);
    res.json(await toClientProject(updated));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await rm(localPath, { force: true });
  }
});

projectsRouter.post('/:id/transcribe', async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });
  if (!stored.videoStoragePath) return res.status(400).json({ error: 'Upload a video before analyzing' });

  const jobDir = path.join(tmpDir, 'jobs', req.params.id);
  await mkdir(jobDir, { recursive: true });
  const videoLocalPath = path.join(jobDir, 'source.mp4');
  const audioLocalPath = path.join(jobDir, 'audio.wav');

  try {
    await bucket.file(stored.videoStoragePath).download({ destination: videoLocalPath });
    await extractAudioForStt(videoLocalPath, audioLocalPath);

    const settings = await getSettings(req.uid!);
    const { language, segments: rawSegments, provider: sttProviderUsed } = await routeTranscribe(
      audioLocalPath,
      stored.targetLanguage,
      settings.sttProvider
    );
    const detectedSourceLanguage = mapDetectedLanguageToAppCode(language);

    // Every STT model loops on non-speech audio, emitting one filler word over and over
    // (measured: 204 of 223 segments were "Okay." on a real interview). Those are stripped
    // before anything downstream sees them — each one would otherwise become a synthesized
    // line in the dub, and would drag the alignment of every real line out of place.
    const { segments: cleanSegments, removed: hallucinated, note: sanitizeNote } =
      sanitizeTranscript(rawSegments);
    console.log(`[transcribe] ${req.params.id}: ${describeTranscriptHealth(rawSegments, cleanSegments)}`);

    const costMeter = createCostMeter();
    recordStt(costMeter, sttProviderUsed, (await probeMedia(audioLocalPath)).durationSeconds);
    console.log(`[cost] transcribe ${req.params.id}: ${summarizeCost(costMeter)}`);

    // STT providers give accurate text but unreliable timing (Gemini estimates and drifts
    // progressively; Sarvam returned a single blob spanning the whole clip). Timing is
    // therefore rebuilt from the audio in two passes, coarse then fine.
    //
    // Pass 1 (always): voice-activity detection finds where speech physically is, and the
    // transcript is partitioned onto those regions. This decides *which* stretch of audio
    // each line belongs to, and never places a line in silence.
    let timedSegments = cleanSegments;
    try {
      const probe = await probeMedia(audioLocalPath);
      const regions = await detectSpeechRegions(audioLocalPath, probe.durationSeconds);
      if (regions.length > 0) {
        timedSegments = alignSegmentsToSpeech(rawSegments, regions).map(retimeWords);
      }
    } catch (err) {
      console.error('[projects] speech alignment failed, keeping provider timings', err);
    }

    // Pass 2 (when the model is installed): a CTC forced alignment solves for the exact
    // frame each word lands on, turning pass 1's region-level estimate into measured
    // word-level timing. Best-effort — a failure here leaves pass 1's timings standing,
    // which is what every project got before this existed.
    if (isCtcAlignAvailable(detectedSourceLanguage)) {
      try {
        timedSegments = await refineTimingsWithCtc(audioLocalPath, detectedSourceLanguage, timedSegments);
      } catch (err) {
        console.error('[projects] forced alignment failed, keeping VAD timings', err);
      }
    }

    const { segments, speakersCount, speakerVoiceMap } = resolveSpeakers(timedSegments);

    const wordsCount = segments.reduce((sum, s) => sum + s.wordsCount, 0);
    const updated = await updateStoredProject(req.uid!, req.params.id, {
      transcriptSegments: segments,
      sourceLanguage: detectedSourceLanguage,
      wordsCount,
      speakersCount,
      speakerVoiceMap,
      currentStep: 'understand',
    });
    res.json({
      ...(await toClientProject(updated)),
      detectedLanguage: getLanguageName(detectedSourceLanguage),
      // Surfaced so the UI can say what happened rather than silently showing fewer lines
      // than the model returned.
      removedSegments: hallucinated,
      sanitizeNote,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await rm(jobDir, { recursive: true, force: true });
  }
});

/**
 * Languages translated at once. The calls are independent, so running them together keeps
 * a five-language project roughly as fast as a one-language one — but not *all* at once,
 * because the providers rate-limit per project and a burst of ten just trips that.
 */
const TRANSLATE_CONCURRENCY = 3;

projectsRouter.post('/:id/translate', async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
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
    const settings = await getSettings(req.uid!);
    // Some STT chunks (e.g. a silent lead-in) come back with empty text — sending those
    // to a translation provider is meaningless and some (Sarvam) reject empty input
    // outright, failing the whole batch. Skip them; they map to an empty translation.
    const translatable = stored.transcriptSegments.filter((s) => s.text.trim().length > 0);
    const sourceLines = translatable.map((s) => ({
      id: s.id,
      text: s.text,
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
          ? await routeTranslateSegments(sourceLines, languageCode, finalStyle, finalAdapt, settings.translateProvider)
          : { translations: {} as Record<string, string> };

      const segments: LocalizedSegment[] = stored.transcriptSegments.map((seg) => ({
        id: `loc-${languageCode}-${seg.id}`,
        segmentId: seg.id,
        startTime: seg.startTime,
        endTime: seg.endTime,
        speaker: seg.speaker,
        sourceText: seg.text,
        translatedText: translations[seg.id] || seg.text,
        isEdited: false,
      }));
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

    const updated = await updateStoredProject(req.uid!, req.params.id, {
      targetLanguage: primary.languageCode,
      targetLanguages: targets,
      languageOutputs,
      translationStyle: finalStyle,
      adaptExpressions: finalAdapt,
      localizedSegments: primary.segments,
      currentStep: 'localize',
    });
    res.json(await toClientProject(updated));
  } catch (err) {
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
projectsRouter.patch('/:id/languages/:code/segments', async (req, res) => {
  const stored = await requireProject(req.uid!, req.params.id);
  if (!stored) return res.status(404).json({ error: 'Project not found' });

  const languageCode = req.params.code;
  const segments = req.body?.localizedSegments;
  if (!Array.isArray(segments)) return res.status(400).json({ error: 'localizedSegments must be an array' });
  if (!projectLanguages(stored).includes(languageCode)) {
    return res.status(404).json({ error: `Project is not being dubbed into ${languageCode}` });
  }

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

  const updated = await updateStoredProject(req.uid!, req.params.id, patch);
  res.json(await toClientProject(updated));
});
