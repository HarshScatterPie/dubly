import { Router } from 'express';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { VOICES, LANGUAGES } from '../../src/data/mockData';
import { createReferenceLoader, isClonedVoiceId, voiceCatalogFor } from '../lib/customVoices';
import { routeSynthesizeSpeech } from '../lib/modelRouter';
import { applyPitchSpeed } from '../lib/ffmpeg';
import { getWavDurationSeconds } from '../lib/audioUtils';
import { getSettings } from '../lib/projectRepo';
import { tmpDir } from '../lib/paths';

export const ttsRouter = Router();

/**
 * Synchronous single-clip synthesis — used by the Text-to-Voice Studio "Generate Voice"
 * action and by voice-catalog sample-quote previews. Full per-project dubbing (segment
 * timed, muxed into video) goes through POST /api/projects/:id/dub instead.
 */
ttsRouter.post('/generate', async (req, res) => {
  const { text, voiceId, languageCode, speed, pitch } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  // Resolved against the user's own catalog, not just the shared one, so their cloned
  // voices are selectable here exactly like the built-in ones.
  const catalog = await voiceCatalogFor(req.uid!, VOICES);
  const voice = catalog.find((v) => v.id === voiceId);
  if (!voice) {
    res.status(400).json({ error: `Unknown voice id: ${voiceId}` });
    return;
  }
  const targetLanguageCode = languageCode || voice.languageCode;
  const langMeta = LANGUAGES.find((l) => l.code === targetLanguageCode);

  const jobDir = path.join(tmpDir, 'tts', randomUUID());
  try {
    const settings = await getSettings(req.uid!);
    const loadReference = createReferenceLoader(req.uid!, jobDir);
    const { audio, provider } = await routeSynthesizeSpeech(
      text,
      voice,
      targetLanguageCode,
      settings.ttsProvider,
      isClonedVoiceId(voice.id) ? await loadReference(voice.id) : undefined
    );
    const shaped = await applyPitchSpeed(audio, pitch ?? 1, speed ?? 1, jobDir);
    const durationSeconds = getWavDurationSeconds(shaped);

    res.json({
      provider,
      audioUrl: `data:audio/wav;base64,${shaped.toString('base64')}`,
      durationSeconds,
      languageName: langMeta?.name || targetLanguageCode,
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  } finally {
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
