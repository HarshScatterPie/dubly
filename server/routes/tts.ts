import { Router } from '../lib/router';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { VOICES, LANGUAGES } from '../../src/data/mockData';
import { createReferenceLoader, isClonedVoiceId, voiceCatalogFor } from '../lib/customVoices';
import { routeSynthesizeSpeech } from '../lib/modelRouter';
import { buildStylePrompt } from '../lib/speechStyle';
import { applySpokenForms } from '../lib/glossary';
import { getGlossary } from '../lib/glossaryStore';
import { applyPitchSpeed } from '../lib/ffmpeg';
import { getWavDurationSeconds } from '../lib/audioUtils';
import { getSettings } from '../lib/projectRepo';
import { tmpDir } from '../lib/paths';
import { rateLimit } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { schemas, validateBody } from '../lib/validation';

export const ttsRouter = Router();

/**
 * Synchronous single-clip synthesis — used by the Text-to-Voice Studio "Generate Voice"
 * action and by voice-catalog sample-quote previews. Full per-project dubbing (segment
 * timed, muxed into video) goes through POST /api/projects/:id/dub instead.
 */
ttsRouter.post('/generate', rateLimit('tts', [['user', rateRules.ttsPerUser]]), validateBody(schemas.tts), async (req, res) => {
  const { text, voiceId, languageCode, speed, pitch, emotion, delivery } = req.body || {};
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
    const [settings, glossary] = await Promise.all([getSettings(req.uid!), getGlossary(req.workspaceId!)]);
    const loadReference = createReferenceLoader(req.uid!, jobDir);
    const { audio, provider } = await routeSynthesizeSpeech(
      // The workspace's pronunciations apply here as in a dub, so a preview is how the render will sound.
      applySpokenForms(text, glossary),
      voice,
      targetLanguageCode,
      settings.ttsProvider,
      {
        cloneReference: isClonedVoiceId(voice.id) ? await loadReference(voice.id) : undefined,
        // Same direction a dub gives the line, so a preview sounds like the render.
        style: buildStylePrompt(emotion, delivery),
        expressive: settings.preferences.expressiveVoices,
        premium: settings.preferences.premiumVoices,
      }
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
