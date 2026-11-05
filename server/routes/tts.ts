import { Router } from '../lib/router';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { VOICES, LANGUAGES } from '../../src/data/mockData';
import { effectiveExtras } from '../../src/lib/planMath';
import { languageVoiced } from '../../src/lib/voiceEngines';
import { routeSynthesizeSpeech } from '../lib/modelRouter';
import { buildStylePrompt } from '../lib/speechStyle';
import { applySpokenForms } from '../lib/glossary';
import { getGlossary } from '../lib/glossaryStore';
import { applyPitchSpeed } from '../lib/ffmpeg';
import { getWavDurationSeconds } from '../lib/audioUtils';
import { getSettings, QuotaExceededError, reserveVoiceMinutes, settleVoiceMinutes } from '../lib/projectRepo';
import { planForWorkspace } from '../lib/plans';
import { tmpDir } from '../lib/paths';
import { rateLimit } from '../lib/rateLimit';
import { limits, rateRules } from '../lib/limits';
import { log } from '../lib/log';
import { schemas, validateBody } from '../lib/validation';

export const ttsRouter = Router();

// Each voice's sample line, as the voice pickers play it: a fixed set of texts whose takes are cached after the first, so free to preview.
const SAMPLE_QUOTES = new Set(VOICES.map((v) => v.sampleQuote.trim()));

// Speech runs at about 14-16 characters a second; holding minutes as if it ran at 12 keeps a clip from outrunning its hold.
const HOLD_CHARS_PER_SECOND = 12;

// Minutes held while a clip of this text is made, in whole tenths (the step the ledger counts in).
export function voiceHoldMinutes(text: string): number {
  return Math.max(1, Math.ceil(Array.from(text).length / HOLD_CHARS_PER_SECOND / 6)) / 10;
}

// Charged clips being made per workspace; with the hold, this bounds how far a burst of requests can voice past the allowance.
const clipsInFlight = new Map<string, number>();

// Test seam: lets the charging run without a voice provider.
let synthesize = routeSynthesizeSpeech;
export function setSpeechSynthesisForTests(fn: typeof routeSynthesizeSpeech | null): void {
  synthesize = fn ?? routeSynthesizeSpeech;
}

/**
 * Synchronous single-clip synthesis — used by the Text-to-Voice Studio "Generate Voice"
 * action, by line previews in the editor and by voice-catalog sample-quote previews. Full
 * per-project dubbing (segment timed, muxed into video) goes through POST /api/projects/:id/dub instead.
 *
 * A clip uses the workspace's minutes by the length the voice spoke, like a dub uses them by video length;
 * a voice's sample line and a take served from the cache cost nothing, so they are free.
 */
ttsRouter.post('/generate', rateLimit('tts', [['user', rateRules.ttsPerUser]]), validateBody(schemas.tts), async (req, res) => {
  const { text, voiceId, languageCode, speed, pitch, emotion, delivery } = req.body || {};
  if (!text || typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ error: 'text is required' });
    return;
  }
  const voice = VOICES.find((v) => v.id === voiceId);
  if (!voice) {
    res.status(400).json({ error: `Unknown voice id: ${voiceId}` });
    return;
  }
  const targetLanguageCode = languageCode || voice.languageCode;
  const langMeta = LANGUAGES.find((l) => l.code === targetLanguageCode);
  const workspaceId = req.workspaceId!;

  const jobDir = path.join(tmpDir, 'tts', randomUUID());
  let counted = false;
  let hold: { minutes: number; period: string } | null = null;
  // Swaps the hold for the seconds voiced, once; a failure settles it with 0, a full refund. The early answers below hold nothing.
  const settle = async (voicedSeconds: number) => {
    if (!hold) return;
    await settleVoiceMinutes(workspaceId, hold.minutes, voicedSeconds, hold.period);
    hold = null;
  };
  try {
    const [settings, glossary, plan] = await Promise.all([getSettings(req.uid!), getGlossary(workspaceId), planForWorkspace(workspaceId)]);
    if (!languageVoiced(targetLanguageCode, plan.voiceEngines)) {
      res.status(400).json({ error: `No voice can speak ${langMeta?.name || targetLanguageCode} right now.`, code: 'LANGUAGE_NOT_VOICED' });
      return;
    }
    // The workspace's pronunciations apply here as in a dub, so a preview is how the render will sound.
    const spokenText = applySpokenForms(text, glossary);
    // A sample line is free only as the pickers send it: with no direction of its own and untouched by the glossary, it maps to a
    // cached take, where any other text or direction would be a new one.
    const charged = !(SAMPLE_QUOTES.has(text.trim()) && spokenText === text && !delivery);
    if (charged) {
      if ((clipsInFlight.get(workspaceId) ?? 0) >= limits.voiceClipsInFlightPerWorkspace) {
        res.setHeader('Retry-After', '2');
        res.status(429).json({ error: 'Another voice clip is still being made in this workspace. Try again in a moment.', code: 'VOICE_BUSY', retryAfterSeconds: 2 });
        return;
      }
      clipsInFlight.set(workspaceId, (clipsInFlight.get(workspaceId) ?? 0) + 1);
      counted = true;
      const minutes = voiceHoldMinutes(spokenText);
      try {
        hold = { minutes, period: await reserveVoiceMinutes(workspaceId, minutes) };
      } catch (err) {
        if (err instanceof QuotaExceededError) {
          res.status(403).json({ error: err.message, code: 'QUOTA_EXCEEDED' });
          return;
        }
        throw err;
      }
    }

    const { audio, provider, fromCache } = await synthesize(spokenText, voice, targetLanguageCode, settings.ttsProvider, {
      // A voice the plan does not include is previewed as the same persona on one it does, exactly as a dub would voice it.
      engines: plan.voiceEngines,
      // Same direction a dub gives the line, so a preview sounds like the render.
      style: buildStylePrompt(emotion, delivery),
      expressive: settings.preferences.expressiveVoices,
      premium: effectiveExtras(plan.paidExtras, settings.preferences, plan.voiceEngines).premiumVoices,
    });
    const shaped = await applyPitchSpeed(audio, pitch ?? 1, speed ?? 1, jobDir);
    // Charged by the length the voice spoke, before pitch and speed reshape it: that is what the voice cost. A cached take cost nothing.
    await settle(fromCache ? 0 : getWavDurationSeconds(audio));

    res.json({
      provider,
      audioUrl: `data:audio/wav;base64,${shaped.toString('base64')}`,
      durationSeconds: getWavDurationSeconds(shaped),
      languageName: langMeta?.name || targetLanguageCode,
    });
  } catch (err) {
    // Refunded before answering, so a client that reloads its usage on the error already sees the minutes back.
    await settle(0).catch((refundErr) => log.error('voice_minutes_refund_failed', refundErr, { workspaceId }));
    res.status(500).json({ error: (err as Error).message });
  } finally {
    if (counted) {
      const left = (clipsInFlight.get(workspaceId) ?? 1) - 1;
      if (left > 0) clipsInFlight.set(workspaceId, left);
      else clipsInFlight.delete(workspaceId);
    }
    await rm(jobDir, { recursive: true, force: true }).catch(() => undefined);
  }
});
