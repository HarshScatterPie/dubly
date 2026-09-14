import type { TranscriptSegment, Voice } from '../../src/types';
import { getLanguageBcp47, getLanguageName, isIndicLanguage, isSarvamSupportedLanguage, toSarvamLanguageCode } from './languageMeta';
import { isVertexConfigured, vertexTranscribe, vertexTranslateSegments } from './vertexClient';
import { googleSynthesizeSpeech, isGoogleTtsConfigured } from './googleTtsClient';
import { readTtsCache, ttsCacheKey, writeTtsCache } from './ttsCache';
import {
  isOpenAIConfigured,
  openaiSynthesizeSpeech,
  openaiTranscribe,
  openaiTranslateSegments,
  type OpenAIVoiceId,
  type RawSttResult,
} from './openaiClient';
import {
  isSarvamConfigured,
  sarvamSynthesizeSpeech,
  sarvamTranscribeChunked,
  sarvamTranslateSegments,
} from './sarvamClient';
import { canCloneInLanguage, isVoiceCloneAvailable, synthesizeClonedSpeech } from './voiceClone';
import { canSpaceCloneLanguage, isSpaceCloneConfigured, synthesizeViaSpace } from './spaceClone';

export type SttProvider = 'auto' | 'sarvam' | 'openai' | 'vertex';
export type TranslateProvider = 'auto' | 'vertex' | 'openai' | 'sarvam';
export type TtsProvider = 'auto' | 'sarvam' | 'vertex' | 'openai';

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
  sarvam: boolean;
  openai: boolean;
  vertex: boolean;
}

export function getProviderStatus(): ProviderStatus {
  return {
    sarvam: isSarvamConfigured(),
    openai: isOpenAIConfigured(),
    vertex: isVertexConfigured(),
  };
}

/** Quota/rate-limit failures are transient and worth waiting out, unlike a bad request. */
function isRateLimitError(err: unknown): boolean {
  const candidate = err as { status?: number; message?: string };
  if (candidate?.status === 429) return true;
  return /RESOURCE_EXHAUSTED|Quota exceeded|rate limit|too many requests/i.test(String(candidate?.message ?? err));
}

const TTS_RATE_LIMIT_BACKOFF_MS = [4000, 10000, 20000];

/** Converts one provider's raw {start,end,text,words?} segments into app-shaped TranscriptSegment[]. Speaker labels are filled in separately by the diarization pass, not here. */
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
  override: SttProvider
): Promise<{ provider: 'sarvam' | 'openai' | 'vertex'; language: string; segments: TranscriptSegment[] }> {
  type Attempt = { provider: 'sarvam' | 'openai' | 'vertex'; run: () => Promise<RawSttResult> };

  const sarvamAttempt: Attempt = {
    provider: 'sarvam',
    // Chunked internally to work around Sarvam's 30s synchronous-call limit. Always
    // auto-detect ('unknown') — this used to be handed the *dub target* language, which
    // silently forced Sarvam to transcribe whatever was actually said (e.g. English NASA
    // audio) as if it were spoken in the target language (e.g. Hindi), since the target
    // and source language have no reliable relationship to each other.
    run: () => sarvamTranscribeChunked(filePath, 'unknown'),
  };
  const openaiAttempt: Attempt = { provider: 'openai', run: () => openaiTranscribe(filePath) };
  const vertexAttempt: Attempt = { provider: 'vertex', run: () => vertexTranscribe(filePath) };

  // The source language is unknown until after transcription, so the *target* dub
  // language is not a valid signal for provider choice (dubbing INTO Hindi very often
  // means the SOURCE is English, not Hindi) — default order is fixed instead, favoring
  // the general-purpose multilingual engines; Sarvam's Indic specialization is opted
  // into via an explicit provider override, not guessed from the target language.
  let ordered: Attempt[];
  if (override === 'sarvam') ordered = [sarvamAttempt, vertexAttempt, openaiAttempt];
  else if (override === 'openai') ordered = [openaiAttempt, vertexAttempt];
  else if (override === 'vertex') ordered = [vertexAttempt, openaiAttempt];
  else ordered = [vertexAttempt, openaiAttempt, sarvamAttempt];

  ordered = ordered.filter((a) => {
    if (a.provider === 'sarvam') return isSarvamConfigured();
    if (a.provider === 'openai') return isOpenAIConfigured();
    return isVertexConfigured();
  });

  if (ordered.length === 0) {
    throw new Error('No speech-to-text provider is configured (set SARVAM_API_KEY, VERTEX_PROJECT_ID, or OPENAI_API_KEY).');
  }

  let lastError: unknown;
  for (const attempt of ordered) {
    try {
      const result = await attempt.run();
      return { provider: attempt.provider, language: result.language, segments: toTranscriptSegments(result.segments) };
    } catch (err) {
      lastError = err;
      console.error(`[modelRouter] STT via ${attempt.provider} failed, trying next provider`, err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Speech-to-text failed');
}

export async function routeTranslateSegments(
  segments: { id: string; text: string }[],
  targetLanguageCode: string,
  style: string,
  adaptExpressions: boolean,
  override: TranslateProvider
): Promise<{ provider: 'vertex' | 'openai' | 'sarvam'; translations: Record<string, string> }> {
  const targetLanguageName = getLanguageName(targetLanguageCode);
  const sarvamViable = isSarvamSupportedLanguage(targetLanguageCode) && isSarvamConfigured();

  type Attempt = { provider: 'vertex' | 'openai' | 'sarvam'; run: () => Promise<Record<string, string>> };
  const vertexAttempt: Attempt = {
    provider: 'vertex',
    run: () => vertexTranslateSegments(segments, targetLanguageName, style, adaptExpressions),
  };
  const openaiAttempt: Attempt = {
    provider: 'openai',
    run: () => openaiTranslateSegments(segments, targetLanguageName, style, adaptExpressions),
  };
  const sarvamAttempt: Attempt = {
    provider: 'sarvam',
    run: () => sarvamTranslateSegments(segments, toSarvamLanguageCode(targetLanguageCode)!, style),
  };

  let ordered: Attempt[];
  if (override === 'vertex') ordered = [vertexAttempt, openaiAttempt];
  else if (override === 'openai') ordered = [openaiAttempt];
  else if (override === 'sarvam') ordered = sarvamViable ? [sarvamAttempt, openaiAttempt] : [openaiAttempt];
  else ordered = isIndicLanguage(targetLanguageCode) && sarvamViable
    ? [sarvamAttempt, vertexAttempt, openaiAttempt]
    : [vertexAttempt, openaiAttempt];

  ordered = ordered.filter((a) => {
    if (a.provider === 'vertex') return isVertexConfigured();
    if (a.provider === 'openai') return isOpenAIConfigured();
    if (a.provider === 'sarvam') return sarvamViable;
    return false;
  });

  if (ordered.length === 0) {
    throw new Error('No translation provider is configured (set VERTEX_PROJECT_ID, OPENAI_API_KEY, or SARVAM_API_KEY).');
  }

  let lastError: unknown;
  for (const attempt of ordered) {
    try {
      const translations = await attempt.run();
      return { provider: attempt.provider, translations };
    } catch (err) {
      lastError = err;
      console.error(`[modelRouter] Translation via ${attempt.provider} failed, trying next provider`, err);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Translation failed');
}

export async function routeSynthesizeSpeech(
  text: string,
  voice: Voice,
  targetLanguageCode: string,
  override: TtsProvider,
  /**
   * The user's own recording, required only when `voice` is one of their cloned voices.
   * Passed in rather than looked up here so this module stays free of storage concerns.
   */
  cloneReference?: { audioPath: string; transcript?: string }
): Promise<{ provider: 'sarvam' | 'vertex' | 'openai' | 'clone'; audio: Buffer; fromCache: boolean }> {
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
    if (cachedClone) return { provider: 'clone', audio: cachedClone, fromCache: true };

    let audio: Buffer;
    if (viaSpace) {
      try {
        audio = await synthesizeViaSpace({
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
        audio = await synthesizeClonedSpeech({
          text,
          referenceAudioPath: cloneReference.audioPath,
          referenceText: cloneReference.transcript,
          languageCode: targetLanguageCode,
        });
      }
    } else {
      audio = await synthesizeClonedSpeech({
        text,
        referenceAudioPath: cloneReference.audioPath,
        referenceText: cloneReference.transcript,
        languageCode: targetLanguageCode,
      });
    }

    await writeTtsCache(cloneCacheKey, audio);
    return { provider: 'clone', audio, fromCache: false };
  }

  const sarvamLangCode = toSarvamLanguageCode(targetLanguageCode);
  const sarvamViable = Boolean(voice.providerVoice.sarvam) && Boolean(sarvamLangCode) && isSarvamConfigured();
  const vertexViable = Boolean(voice.providerVoice.vertex) && isGoogleTtsConfigured();
  const openaiViable = isOpenAIConfigured();

  type Attempt = { provider: 'sarvam' | 'vertex' | 'openai'; run: () => Promise<Buffer> };
  const sarvamAttempt: Attempt = {
    provider: 'sarvam',
    run: () => sarvamSynthesizeSpeech(text, voice.providerVoice.sarvam!, sarvamLangCode!),
  };
  // Google Cloud TTS rather than Gemini's preview TTS model — same GCP project and
  // credits, but production quotas instead of a per-minute cap that a multi-segment dub
  // exhausts, plus real per-language voices instead of one language-agnostic timbre.
  const vertexAttempt: Attempt = {
    provider: 'vertex',
    run: () =>
      googleSynthesizeSpeech(
        text,
        getLanguageBcp47(targetLanguageCode),
        voice.providerVoice.vertex!,
        voice.gender
      ),
  };
  const openaiAttempt: Attempt = {
    provider: 'openai',
    run: () => openaiSynthesizeSpeech(text, voice.providerVoice.openai as OpenAIVoiceId),
  };

  let ordered: Attempt[];
  if (voice.provider === 'vertex') ordered = vertexViable ? [vertexAttempt] : (sarvamViable ? [sarvamAttempt] : [vertexAttempt]);
  else if (voice.provider === 'sarvam') ordered = sarvamViable ? [sarvamAttempt] : (vertexViable ? [vertexAttempt] : [sarvamAttempt]);
  else if (override === 'sarvam') ordered = sarvamViable ? [sarvamAttempt] : [vertexAttempt];
  else if (override === 'vertex') ordered = vertexViable ? [vertexAttempt] : [sarvamAttempt];
  else if (isIndicLanguage(targetLanguageCode))
    ordered = [
      ...(vertexViable ? [vertexAttempt] : []),
      ...(sarvamViable ? [sarvamAttempt] : []),
    ];
  else ordered = [...(vertexViable ? [vertexAttempt] : [])];

  ordered = ordered.filter((a) =>
    a.provider === 'sarvam' ? sarvamViable : a.provider === 'vertex' ? vertexViable : openaiViable
  );

  if (ordered.length === 0) {
    throw new Error('No text-to-speech provider is configured (set SARVAM_API_KEY, VERTEX_PROJECT_ID, or OPENAI_API_KEY).');
  }

  // Identical input yields identical audio, and TTS is billed per character — so never
  // pay for the same synthesis twice (repeated lines, re-runs, or a retry after a
  // partway failure). Keyed on everything that can change the output.
  const cacheKey = ttsCacheKey([override, voice.id, targetLanguageCode, text]);
  const cached = await readTtsCache(cacheKey);
  if (cached) {
    return { provider: ordered[0].provider, audio: cached, fromCache: true };
  }

  let lastError: unknown;
  for (const attempt of ordered) {
    for (let retry = 0; ; retry++) {
      try {
        const audio = await attempt.run();
        await writeTtsCache(cacheKey, audio);
        return { provider: attempt.provider, audio, fromCache: false };
      } catch (err) {
        lastError = err;
        // A dub synthesizes one clip per segment back-to-back, which is exactly the shape
        // that trips per-minute quotas (Gemini's preview TTS model has a low one). Those
        // are transient, so wait them out on the same provider rather than immediately
        // falling through — falling through would otherwise burn the remaining providers
        // on a problem that fixes itself in seconds, and fail the whole render.
        if (isRateLimitError(err) && retry < TTS_RATE_LIMIT_BACKOFF_MS.length) {
          const waitMs = TTS_RATE_LIMIT_BACKOFF_MS[retry];
          console.warn(`[modelRouter] TTS via ${attempt.provider} rate-limited, retrying in ${waitMs}ms`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        console.error(`[modelRouter] TTS via ${attempt.provider} failed, trying next provider`, err);
        break;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Text-to-speech failed');
}
