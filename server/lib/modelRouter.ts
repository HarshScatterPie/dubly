import type { GlossaryEntry, SpeakerProfile, TranscriptSegment, Voice, VoiceEngine } from '../../src/types';
import { isPerformanceTag, stripPerformanceTags } from './performance';
import { getLanguageBcp47, getLanguageName, toolLanguageCode } from './languageMeta';
import { isVertexConfigured, vertexTranscribe, vertexTranslateSegments, type RawSttResult, type TranscriptWindow } from './vertexClient';
import type { TranslatableSegment, TranslationContext } from './translatePrompt';
import { googleSynthesizeSpeech, isGoogleTtsConfigured, ttsRouteFor, usableGeminiTtsModels, type TtsEngine } from './googleTtsClient';
import { isGeminiSpeechConfigured } from './geminiSpeech';
import { readTtsCache, ttsCacheKey, writeTtsCache } from './ttsCache';
import { trimSilence } from './audioUtils';
import { voiceForPlan } from '../../src/lib/voiceEngines';
import { VOICES } from '../../src/data/mockData';
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
    ...(seg.delivery ? { delivery: seg.delivery } : {}),
    ...(seg.performance ? { performance: seg.performance } : {}),
  }));
}

export async function routeTranscribe(
  filePath: string,
  targetLanguageCode: string,
  override: SttProvider,
  onChunkDone?: (done: number, total: number, language: string) => void | Promise<void>
): Promise<{ provider: 'vertex'; language: string; segments: TranscriptSegment[]; speakers: Record<string, SpeakerProfile>; windows?: TranscriptWindow[] }> {
  if (!isVertexConfigured()) {
    throw new Error('No speech-to-text provider is configured (set VERTEX_PROJECT_ID and provide gcp-service-account.json).');
  }
  const result = await vertexTranscribe(filePath, onChunkDone);
  return { provider: 'vertex', language: result.language, segments: toTranscriptSegments(result.segments), speakers: result.speakers ?? {}, windows: result.windows };
}

export async function routeTranslateSegments(
  segments: TranslatableSegment[],
  targetLanguageCode: string,
  style: string,
  adaptExpressions: boolean,
  override: TranslateProvider,
  glossary: GlossaryEntry[] = [],
  context: TranslationContext = {}
): Promise<{ provider: 'vertex'; translations: Record<string, string> }> {
  if (!isVertexConfigured()) {
    throw new Error('No translation provider is configured (set VERTEX_PROJECT_ID and provide gcp-service-account.json).');
  }
  const targetLanguageName = getLanguageName(targetLanguageCode);
  const translations = await vertexTranslateSegments(segments, targetLanguageCode, targetLanguageName, style, adaptExpressions, glossary, context);
  return { provider: 'vertex', translations };
}

// Cleans text the voice would otherwise read literally or stumble on: stage directions, stray quotes, missing final punctuation. Performance tags are kept for the voice to act.
export function normalizeTextForSpeech(raw: string): string {
  let text = raw
    .replace(/\[([^\]]*)\]/g, (whole, inner: string) => (isPerformanceTag(inner) ? ` [${inner.trim().toLowerCase().replace(/\s+/g, ' ')}] ` : ' '))
    .replace(/\([^)]*(music|laugh|applause|noise|inaudible|silence)[^)]*\)/gi, ' ')
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
  requestedVoice: Voice,
  targetLanguageCode: string,
  override: TtsProvider,
  opts: {
    // The engines the workspace's plan includes. A voice on any other engine is voiced as the same persona on an allowed one.
    engines: readonly VoiceEngine[];
    // Emotion and delivery direction for Gemini voices (see speechStyle.ts); Chirp3-HD ignores it.
    style?: string;
    // Off: steady, uniform reads, with no delivery direction and no performed laughs or sighs.
    expressive?: boolean;
    // Above 0, a new performance of the same line (cache bypassed); used for AI-review retakes.
    take?: number;
    // The user turned on premium voices (paid extra); without it a premium take is neither made nor served from cache.
    premium?: boolean;
  }
): Promise<{ provider: 'vertex'; engine: TtsEngine; model?: string; audio: Buffer; fromCache: boolean }> {
  const { engines, expressive = true, take = 0, premium = false } = opts;
  const style = expressive ? opts.style ?? '' : '';
  const spokenText = normalizeTextForSpeech(rawText) || rawText.trim();
  // Tags are only performed by expressive Gemini voices; Chirp3-HD strips them itself.
  const text = expressive ? spokenText : stripPerformanceTags(spokenText);

  const voice = voiceForPlan(requestedVoice, engines, VOICES);
  const route = ttsRouteFor(voice.engine, { premium, engines });
  if (!isGoogleTtsConfigured() && !isGeminiSpeechConfigured()) {
    throw new Error('No text-to-speech provider is configured (set GEMINI_API_KEY, or provide gcp-service-account.json).');
  }

  // Identical input yields identical audio, and TTS is billed per character — so never
  // pay for the same synthesis twice (repeated lines, re-runs, or a retry after a
  // partway failure). Keyed on everything that can change the output.
  const bcp47 = getLanguageBcp47(targetLanguageCode);
  // For a dialect Chirp3-HD does not speak, its related language's voices read the script (Hindi for Bhojpuri).
  const baseCode = toolLanguageCode(targetLanguageCode);
  const chirpFallbackBcp47 = baseCode !== targetLanguageCode ? getLanguageBcp47(baseCode) : undefined;
  // A retake asked for by the AI review must be a fresh performance, not the cached take it just rejected.
  const takeSuffix = take > 0 ? [`take-${take}`] : [];
  const chirpKey = ttsCacheKey([override, voice.id, targetLanguageCode, text, ...takeSuffix]);
  const geminiKeyFor = (model: string) => ttsCacheKey([override, 'gemini', model, voice.id, targetLanguageCode, style, text, ...takeSuffix]);
  // Looked up in the order the route would voice the line: a Chirp 3 HD voice's own take first, a Gemini voice's models best first.
  if (route.chirp === 'first') {
    const cachedChirp = await readTtsCache(chirpKey);
    if (cachedChirp) return { provider: 'vertex', engine: 'chirp', audio: trimSilence(cachedChirp), fromCache: true };
  }
  for (const model of route.gemini) {
    const cachedGemini = await readTtsCache(geminiKeyFor(model));
    if (cachedGemini) return { provider: 'vertex', engine: 'gemini', model, audio: trimSilence(cachedGemini), fromCache: true };
  }
  if (route.chirp === 'fallback' && usableGeminiTtsModels(route, bcp47).length === 0) {
    const cachedChirp = await readTtsCache(chirpKey);
    if (cachedChirp) return { provider: 'vertex', engine: 'chirp', audio: trimSilence(cachedChirp), fromCache: true };
  }

  for (let retry = 0; ; retry++) {
    try {
      const result = await googleSynthesizeSpeech(text, bcp47, voice.providerVoice.vertex, voice.gender, style, route, chirpFallbackBcp47);
      const audio = trimSilence(result.audio);
      await writeTtsCache(result.engine === 'gemini' && result.model ? geminiKeyFor(result.model) : chirpKey, audio);
      return { provider: 'vertex', engine: result.engine, model: result.model, audio, fromCache: false };
    } catch (err) {
      // A dub synthesizes one clip per segment back-to-back, which is exactly the shape
      // that trips per-minute quotas. Wait transient failures out rather than failing the whole render.
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

