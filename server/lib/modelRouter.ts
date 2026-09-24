import type { TranscriptSegment, Voice } from '../../src/types';
import { getLanguageBcp47, getLanguageName } from './languageMeta';
import { isVertexConfigured, vertexTranscribe, vertexTranslateSegments, type RawSttResult } from './vertexClient';
import type { TranslatableSegment } from './translatePrompt';
import { googleSynthesizeSpeech, isGoogleTtsConfigured } from './googleTtsClient';
import { readTtsCache, ttsCacheKey, writeTtsCache } from './ttsCache';
import { getWavDurationSeconds, trimSilence } from './audioUtils';
import { canCloneInLanguage, isVoiceCloneAvailable, synthesizeClonedSpeech } from './voiceClone';
import { canSpaceCloneLanguage, isSpaceCloneConfigured, synthesizeViaSpace } from './spaceClone';
import { log } from './log';

// Every provider here is Google's own (Vertex AI / Gemini for STT + translation, Google
// Cloud TTS for synthesis). 'auto' and 'vertex' are equivalent today — the type keeps the
// shape callers and stored per-project settings already expect, in case a second Google
// engine (e.g. a dedicated Speech-to-Text model) is added later.
export type SttProvider = 'auto' | 'vertex';
export type TranslateProvider = 'auto' | 'vertex';
export type TtsProvider = 'auto' | 'vertex';

export interface ProviderSettings {
  sttProvider: SttProvider;
  translateProvider: TranslateProvider;
  ttsProvider: TtsProvider;
}

export const DEFAULT_PROVIDER_SETTINGS: ProviderSettings = {
  sttProvider: 'auto',
  translateProvider: 'auto',
  ttsProvider: 'auto',
};

export interface ProviderStatus {
  vertex: boolean;
}

export function getProviderStatus(): ProviderStatus {
  return { vertex: isVertexConfigured() };
}

/**
 * Rate limits, transient server errors and dropped connections are all worth waiting out
 * rather than failing the render for, unlike a genuinely bad request. This matters more
 * now than it used to: with Sarvam/OpenAI gone there is no second TTS provider to fall
 * through to, so a blip on Google's end used to be absorbed by a fallback and now has to
 * be absorbed by retrying the same call instead.
 */
function isTransientTtsError(err: unknown): boolean {
  const candidate = err as { status?: number; code?: string; message?: string };
  if (candidate?.status === 429 || candidate?.status === 500 || candidate?.status === 503) return true;
  if (candidate?.code === 'ECONNRESET' || candidate?.code === 'ETIMEDOUT' || candidate?.code === 'ECONNREFUSED') return true;
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|Quota exceeded|rate limit|too many requests|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    String(candidate?.message ?? err)
  );
}

const TTS_RETRY_BACKOFF_MS = [4000, 10000, 20000];

/** Converts the raw {start,end,text,words?} segments Vertex returns into app-shaped TranscriptSegment[]. Speaker labels are filled in separately by the diarization pass, not here. */
function toTranscriptSegments(raw: RawSttResult['segments']): TranscriptSegment[] {
  return raw.map((seg, idx) => ({
    id: `seg-${idx + 1}`,
    startTime: Math.max(0, seg.start),
    endTime: Math.max(seg.start + 0.5, seg.end),
    text: seg.text,
    speaker: seg.speaker || 'Speaker 1',
    wordsCount: seg.text.split(/\s+/).filter(Boolean).length,
    confidence: seg.confidence,
    words: seg.words,
  }));
}

export async function routeTranscribe(
  filePath: string,
  targetLanguageCode: string,
  override: SttProvider,
  onChunkDone?: (done: number, total: number, language: string) => void | Promise<void>
): Promise<{ provider: 'vertex'; language: string; segments: TranscriptSegment[] }> {
  if (!isVertexConfigured()) {
    throw new Error('No speech-to-text provider is configured (set VERTEX_PROJECT_ID and provide gcp-service-account.json).');
  }
  const result = await vertexTranscribe(filePath, onChunkDone);
  return { provider: 'vertex', language: result.language, segments: toTranscriptSegments(result.segments) };
}

export async function routeTranslateSegments(
  segments: TranslatableSegment[],
  targetLanguageCode: string,
  style: string,
  adaptExpressions: boolean,
  override: TranslateProvider
): Promise<{ provider: 'vertex'; translations: Record<string, string> }> {
  if (!isVertexConfigured()) {
    throw new Error('No translation provider is configured (set VERTEX_PROJECT_ID and provide gcp-service-account.json).');
  }
  const targetLanguageName = getLanguageName(targetLanguageCode);
  const translations = await vertexTranslateSegments(segments, targetLanguageCode, targetLanguageName, style, adaptExpressions);
  return { provider: 'vertex', translations };
}

const CLONE_MAX_ATTEMPTS = 3;
// Rough speaking-rate bounds in seconds per character, loose enough to cover every supported script.
const MIN_SECONDS_PER_CHAR = 0.025;
const MAX_SECONDS_PER_CHAR = 0.2;

function expectedSpeechRange(text: string): [number, number] {
  const chars = text.replace(/\s+/g, '').length;
  return [chars * MIN_SECONDS_PER_CHAR, chars * MAX_SECONDS_PER_CHAR + 1];
}

function isPlausibleSpeechLength(audio: Buffer, text: string): boolean {
  const duration = getWavDurationSeconds(audio);
  if (duration <= 0) return true;
  const [min, max] = expectedSpeechRange(text);
  return duration >= min && duration <= max;
}

function lengthError(audio: Buffer, text: string): number {
  const duration = getWavDurationSeconds(audio);
  const [min, max] = expectedSpeechRange(text);
  return duration < min ? min - duration : duration > max ? duration - max : 0;
}

// Cleans text the voice would otherwise read literally or stumble on: stage directions, stray quotes, missing final punctuation.
export function normalizeTextForSpeech(raw: string): string {
  let text = raw
    .replace(/\[[^\]]*\]|\([^)]*(music|laugh|applause|noise|inaudible|silence)[^)]*\)/gi, ' ')
    .replace(/[“”„"«»]/g, '')
    .replace(/^['‘’]+|['‘’]+$/g, '')
    .replace(/[*_#~`|<>{}]/g, ' ')
    .replace(/([!?.,।])\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (text && !/[.!?।॥。！？…,:;]$/.test(text)) {
    text += /[ऀ-ॿ]/.test(text) ? '।' : '.';
  }
  return text;
}

export async function routeSynthesizeSpeech(
  rawText: string,
  voice: Voice,
  targetLanguageCode: string,
  override: TtsProvider,
  /**
   * The user's own recording, required only when `voice` is one of their cloned voices.
   * Passed in rather than looked up here so this module stays free of storage concerns.
   */
  cloneReference?: { audioPath: string; transcript?: string }
): Promise<{ provider: 'vertex' | 'clone'; audio: Buffer; fromCache: boolean }> {
  const text = normalizeTextForSpeech(rawText) || rawText.trim();
  // A cloned voice is the user's own voice: substituting a stock voice for it would be
  // silently wrong in a way they would only notice after the render. So this path either
  // produces their voice or fails loudly, with no provider fallback.
  if (voice.provider === 'clone') {
    if (!cloneReference) throw new Error(`No reference recording available for cloned voice ${voice.id}`);

    // Same model either way; the only question is whose hardware runs it. A configured
    // Space wins because it has a GPU and this host, in the common case, does not.
    const viaSpace = isSpaceCloneConfigured() && canSpaceCloneLanguage(targetLanguageCode);
    const viaLocal = isVoiceCloneAvailable() && canCloneInLanguage(targetLanguageCode);
    if (!viaSpace && !viaLocal) {
      throw new Error(
        isSpaceCloneConfigured() || isVoiceCloneAvailable()
          ? `No cloning engine available can speak ${targetLanguageCode}.`
          : 'Voice cloning is not set up. Point HF_SPACE_URL at a cloning Space, or install chatterbox-tts locally.'
      );
    }

    const cloneCacheKey = ttsCacheKey(['clone', voice.id, targetLanguageCode, text]);
    const cachedClone = await readTtsCache(cloneCacheKey);
    if (cachedClone) return { provider: 'clone', audio: trimSilence(cachedClone), fromCache: true };

    const synthesizeOnce = async (): Promise<Buffer> => {
      if (viaSpace) {
        try {
          return await synthesizeViaSpace({
            text,
            referenceAudioPath: cloneReference.audioPath,
            languageCode: targetLanguageCode,
          });
        } catch (err) {
          // A Space can be asleep, queued behind other users, or out of daily quota. Those
          // are all transient and local synthesis still produces the right voice, just
          // slowly — so fall back rather than failing the render.
          if (!viaLocal) throw err;
          console.warn('[modelRouter] cloning Space unavailable, falling back to local', err);
        }
      }
      return synthesizeClonedSpeech({
        text,
        referenceAudioPath: cloneReference.audioPath,
        referenceText: cloneReference.transcript,
        languageCode: targetLanguageCode,
      });
    };

    // Generative cloning models sometimes babble past the text or cut off early; re-roll those takes.
    let audio = trimSilence(await synthesizeOnce());
    for (let attempt = 1; attempt < CLONE_MAX_ATTEMPTS && !isPlausibleSpeechLength(audio, text); attempt++) {
      console.warn(`[modelRouter] cloned take ${attempt} has implausible length for its text, re-synthesizing`);
      const retake = trimSilence(await synthesizeOnce());
      if (isPlausibleSpeechLength(retake, text) || lengthError(retake, text) < lengthError(audio, text)) audio = retake;
    }

    await writeTtsCache(cloneCacheKey, audio);
    return { provider: 'clone', audio, fromCache: false };
  }

  if (!voice.providerVoice.vertex || !isGoogleTtsConfigured()) {
    throw new Error('No text-to-speech provider is configured (set VERTEX_PROJECT_ID and provide gcp-service-account.json).');
  }

  // Identical input yields identical audio, and TTS is billed per character — so never
  // pay for the same synthesis twice (repeated lines, re-runs, or a retry after a
  // partway failure). Keyed on everything that can change the output.
  const cacheKey = ttsCacheKey([override, voice.id, targetLanguageCode, text]);
  const cached = await readTtsCache(cacheKey);
  if (cached) {
    return { provider: 'vertex', audio: trimSilence(cached), fromCache: true };
  }

  for (let retry = 0; ; retry++) {
    try {
      // Google Cloud TTS rather than Gemini's preview TTS model — same GCP project and
      // credits, but production quotas instead of a per-minute cap that a multi-segment
      // dub exhausts, plus real per-language voices instead of one language-agnostic timbre.
      const audio = trimSilence(await googleSynthesizeSpeech(text, getLanguageBcp47(targetLanguageCode), voice.providerVoice.vertex, voice.gender));
      await writeTtsCache(cacheKey, audio);
      return { provider: 'vertex', audio, fromCache: false };
    } catch (err) {
      // A dub synthesizes one clip per segment back-to-back, which is exactly the shape
      // that trips per-minute quotas, and there's no second provider to fall through to
      // any more. Wait transient failures out rather than failing the whole render.
      if (isTransientTtsError(err) && retry < TTS_RETRY_BACKOFF_MS.length) {
        const waitMs = TTS_RETRY_BACKOFF_MS[retry];
        log.warn('provider_retry', { provider: 'google-tts', operation: 'synthesize', attempt: retry + 1, waitMs }, `[modelRouter] TTS failed (attempt ${retry + 1}/${TTS_RETRY_BACKOFF_MS.length + 1}), retrying in ${waitMs}ms: ${(err as Error)?.message}`);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
        continue;
      }
      log.error('provider_error', err, { provider: 'google-tts', operation: 'synthesize', attempts: retry + 1 });
      throw err;
    }
  }
}

