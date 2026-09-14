import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { bucket, invalidateSignedUrlCache, uploadFileToStorage } from '../lib/firebaseAdmin';
import {
  CLONED_VOICE_PREFIX,
  createCustomVoice,
  newCustomVoiceId,
  deleteCustomVoice,
  getCustomVoice,
  listCustomVoices,
  toClientCustomVoice,
} from '../lib/customVoices';
import { extractAudioForStt, probeMedia } from '../lib/ffmpeg';
import { routeTranscribe } from '../lib/modelRouter';
import { getSettings } from '../lib/projectRepo';
import { mapDetectedLanguageToAppCode } from '../lib/languageMeta';
import { installedCloneEngines, isVoiceCloneAvailable } from '../lib/voiceClone';
import { isSpaceCloneConfigured } from '../lib/spaceClone';
import { tmpDir } from '../lib/paths';

export const voicesRouter = Router();

/**
 * Bounds on a usable reference recording.
 *
 * Zero-shot cloning reads speaker identity from a few seconds of clean speech; more does
 * not help and a very long file just makes every synthesis slower. Too short and the clone
 * comes out unstable, which reads to the user as "the feature is broken" rather than "the
 * sample was too short" — so it is rejected up front with a reason.
 */
const MIN_SAMPLE_SECONDS = 5;
const MAX_SAMPLE_SECONDS = 120;

const uploadDir = path.join(tmpDir, 'voice-uploads');
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
    filename: (_req, file, cb) => cb(null, `${randomUUID()}${path.extname(file.originalname) || '.webm'}`),
  }),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^audio\/|^video\/webm/.test(file.mimetype) && !/\.(wav|mp3|m4a|ogg|webm|flac)$/i.test(file.originalname)) {
      cb(new Error('Upload an audio recording (wav/mp3/m4a/ogg/webm)'));
      return;
    }
    cb(null, true);
  },
});

voicesRouter.get('/', async (req, res) => {
  const voices = await listCustomVoices(req.uid!);
  res.json({
    voices: await Promise.all(voices.map(toClientCustomVoice)),
    // A configured Space counts as available even with nothing installed locally — that
    // is the whole point of it.
    cloningAvailable: isVoiceCloneAvailable() || isSpaceCloneConfigured(),
    engines: { ...installedCloneEngines(), gpuSpace: isSpaceCloneConfigured() },
  });
});

/**
 * Registers a new cloned voice from a recording.
 *
 * The sample is transcribed here rather than asked of the user: one of the two engines
 * needs the reference transcript to align against, and making someone type out what they
 * just said would be a pointless step when the STT pipeline is already sitting right here.
 */
voicesRouter.post('/', upload.single('sample'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No recording uploaded' });

  const jobDir = path.join(tmpDir, 'voice-jobs', randomUUID());
  try {
    if (!isVoiceCloneAvailable() && !isSpaceCloneConfigured()) {
      return res.status(503).json({
        error:
          'Voice cloning is not set up. Either point HF_SPACE_URL at a cloning Space (free GPU, nothing to install), ' +
          'or install an engine into the server venv with `pip install chatterbox-tts`.',
      });
    }

    await mkdir(jobDir, { recursive: true });
    // Normalized to the same 16kHz mono WAV the STT path uses — browsers record webm/opus,
    // which neither cloning engine reads directly.
    const wavPath = path.join(jobDir, 'sample.wav');
    await extractAudioForStt(req.file.path, wavPath);

    const { durationSeconds } = await probeMedia(wavPath);
    if (durationSeconds < MIN_SAMPLE_SECONDS) {
      return res.status(400).json({
        error: `That recording is only ${durationSeconds.toFixed(1)}s. Record at least ${MIN_SAMPLE_SECONDS}s of clear speech for a stable clone.`,
      });
    }
    if (durationSeconds > MAX_SAMPLE_SECONDS) {
      return res.status(400).json({
        error: `That recording is ${Math.round(durationSeconds)}s. Keep it under ${MAX_SAMPLE_SECONDS}s — extra length does not improve the clone.`,
      });
    }

    const settings = await getSettings(req.uid!);
    let sampleTranscript = '';
    let detectedLanguage = req.body?.languageCode || 'en';
    try {
      const result = await routeTranscribe(wavPath, detectedLanguage, settings.sttProvider);
      sampleTranscript = result.segments.map((s) => s.text).join(' ').trim();
      detectedLanguage = mapDetectedLanguageToAppCode(result.language);
    } catch (err) {
      // Only one of the two engines needs the transcript, so a failure here degrades the
      // feature rather than blocking it — the voice still works on Chatterbox.
      console.error('[voices] could not transcribe the sample, saving without a transcript', err);
    }

    // The folder is named after the voice's own id rather than a second, unrelated UUID —
    // otherwise a bucket path cannot be traced back to the voice that owns it, which makes
    // orphaned samples impossible to spot.
    const voiceId = newCustomVoiceId();
    const sampleStoragePath = `users/${req.uid!}/voices/${voiceId.replace(CLONED_VOICE_PREFIX, '')}/sample.wav`;
    await uploadFileToStorage(sampleStoragePath, wavPath, 'audio/wav');

    const stored = await createCustomVoice(req.uid!, {
      id: voiceId,
      name: (req.body?.name || '').trim() || 'My voice',
      sampleStoragePath,
      sampleTranscript,
      languageCode: detectedLanguage,
      gender: req.body?.gender === 'male' || req.body?.gender === 'female' ? req.body.gender : 'non-binary',
    });

    res.status(201).json(await toClientCustomVoice(stored));
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await rm(req.file.path, { force: true }).catch(() => undefined);
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
});

voicesRouter.delete('/:id', async (req, res) => {
  const voice = await getCustomVoice(req.uid!, req.params.id);
  if (!voice) return res.status(404).json({ error: 'Voice not found' });

  await bucket.file(voice.sampleStoragePath).delete({ ignoreNotFound: true });
  invalidateSignedUrlCache(voice.sampleStoragePath);
  await deleteCustomVoice(req.uid!, req.params.id);
  res.status(204).send();
});
