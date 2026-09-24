/**
 * Rough per-render cost accounting, so spend is visible instead of only showing up on a
 * bill at the end of the month.
 *
 * These are published list prices converted to INR, not a billing integration — they
 * ignore free tiers and any negotiated rate, so treat the numbers as an upper-bound
 * estimate of what a render costs rather than an invoice.
 */
import { env } from './env';

const USD_TO_INR = 83;

// Google Cloud TTS list prices per 1M characters.
const GOOGLE_CHIRP3_HD_PER_1M_USD = 30;
// gemini-2.5-flash-tts bills $10 per 1M audio tokens (25/s) plus $0.50 per 1M text tokens; about 0.07 s of speech per character.
const GEMINI_TTS_PER_1M_CHARS_USD = 18;
const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;

interface GeminiPrice {
  inputPer1M: number;
  audioInputPer1M: number;
  outputPer1M: number;
}

// Paid-tier USD list prices per 1M tokens (ai.google.dev/gemini-api/docs/pricing, Sep 2026); output includes thinking tokens.
export const GEMINI_PRICES_USD: Record<string, GeminiPrice> = {
  'gemini-3.5-flash-lite': { inputPer1M: 0.3, audioInputPer1M: 0.3, outputPer1M: 2.5 },
  'gemini-3.1-flash-lite': { inputPer1M: 0.25, audioInputPer1M: 0.5, outputPer1M: 1.5 },
  // 3.6/3.7/3.8 Flash are $0.75/$3.75 until 2026-12-31; the 2027 standard rate is used as the upper bound.
  'gemini-3.8-flash': { inputPer1M: 1.5, audioInputPer1M: 1.5, outputPer1M: 7.5 },
  'gemini-3.7-flash': { inputPer1M: 1.5, audioInputPer1M: 1.5, outputPer1M: 7.5 },
  'gemini-3.6-flash': { inputPer1M: 1.5, audioInputPer1M: 1.5, outputPer1M: 7.5 },
  'gemini-3.5-flash': { inputPer1M: 1.5, audioInputPer1M: 1.5, outputPer1M: 9 },
  'gemini-2.5-flash': { inputPer1M: 0.3, audioInputPer1M: 1, outputPer1M: 2.5 },
};

export interface GeminiUsage {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
}

/** Actual cost of one Gemini call in INR from its reported usage, or null for a model missing from the price table. */
export function geminiCallCostInr(model: string, usage: GeminiUsage | undefined): number | null {
  const price = GEMINI_PRICES_USD[model];
  if (!price || !usage) return null;
  const audioTokens = (usage.promptTokensDetails || [])
    .filter((d) => d.modality === 'AUDIO')
    .reduce((sum, d) => sum + (d.tokenCount || 0), 0);
  const otherInputTokens = Math.max(0, (usage.promptTokenCount || 0) - audioTokens);
  const outputTokens = (usage.candidatesTokenCount || 0) + (usage.thoughtsTokenCount || 0);
  const usd =
    (audioTokens * price.audioInputPer1M + otherInputTokens * price.inputPer1M + outputTokens * price.outputPer1M) / 1_000_000;
  return usd * USD_TO_INR;
}

/** One log line per Gemini call so translation and STT spend both show up, not just the audio estimate. */
export function logGeminiCallCost(label: string, model: string, usage: GeminiUsage | undefined): void {
  const cost = geminiCallCostInr(model, usage);
  const output = (usage?.candidatesTokenCount || 0) + (usage?.thoughtsTokenCount || 0);
  console.log(
    `[cost] gemini ${label} ${model} in=${usage?.promptTokenCount ?? '?'} out=${output} => ${cost === null ? 'price unknown' : `₹${cost.toFixed(4)}`}`
  );
}

export interface CostMeter {
  ttsCharsByProvider: Record<string, number>;
  ttsCharsServedFromCache: number;
  sttSecondsByProvider: Record<string, number>;
}

export function createCostMeter(): CostMeter {
  return { ttsCharsByProvider: {}, ttsCharsServedFromCache: 0, sttSecondsByProvider: {} };
}

export function recordTts(meter: CostMeter, provider: string, chars: number, fromCache: boolean): void {
  if (fromCache) {
    meter.ttsCharsServedFromCache += chars;
    return;
  }
  meter.ttsCharsByProvider[provider] = (meter.ttsCharsByProvider[provider] || 0) + chars;
}

export function recordStt(meter: CostMeter, provider: string, seconds: number): void {
  meter.sttSecondsByProvider[provider] = (meter.sttSecondsByProvider[provider] || 0) + seconds;
}

function ttsCostInr(provider: string, chars: number): number {
  if (provider === 'vertex') return (chars / 1_000_000) * GOOGLE_CHIRP3_HD_PER_1M_USD * USD_TO_INR;
  if (provider === 'gemini-tts') return (chars / 1_000_000) * GEMINI_TTS_PER_1M_CHARS_USD * USD_TO_INR;
  return 0;
}

function sttCostInr(provider: string, seconds: number): number {
  if (provider === 'vertex') {
    const tokens = seconds * GEMINI_AUDIO_TOKENS_PER_SECOND;
    const price = GEMINI_PRICES_USD[env.geminiSttModel]?.audioInputPer1M ?? GEMINI_PRICES_USD['gemini-3.8-flash'].audioInputPer1M;
    return (tokens / 1_000_000) * price * USD_TO_INR;
  }
  return 0;
}

export interface CostEstimate {
  ttsChars: number;
  ttsCharsFromCache: number;
  sttSeconds: number;
  estimatedInr: number;
}

// The same numbers as summarizeCost, as data, for storing on a job record.
export function costEstimate(meter: CostMeter): CostEstimate {
  const tts = Object.entries(meter.ttsCharsByProvider);
  const stt = Object.entries(meter.sttSecondsByProvider);
  const estimatedInr =
    tts.reduce((sum, [provider, chars]) => sum + ttsCostInr(provider, chars), 0) +
    stt.reduce((sum, [provider, seconds]) => sum + sttCostInr(provider, seconds), 0);
  return {
    ttsChars: tts.reduce((sum, [, chars]) => sum + chars, 0),
    ttsCharsFromCache: meter.ttsCharsServedFromCache,
    sttSeconds: Math.round(stt.reduce((sum, [, seconds]) => sum + seconds, 0)),
    estimatedInr: Math.round(estimatedInr * 100) / 100,
  };
}

export function summarizeCost(meter: CostMeter): string {
  let total = 0;
  const parts: string[] = [];

  for (const [provider, chars] of Object.entries(meter.ttsCharsByProvider)) {
    const cost = ttsCostInr(provider, chars);
    total += cost;
    parts.push(`tts/${provider} ${chars} chars ≈ ₹${cost.toFixed(2)}`);
  }
  for (const [provider, seconds] of Object.entries(meter.sttSecondsByProvider)) {
    const cost = sttCostInr(provider, seconds);
    total += cost;
    parts.push(`stt/${provider} ${seconds.toFixed(0)}s ≈ ₹${cost.toFixed(2)}`);
  }
  if (meter.ttsCharsServedFromCache > 0) {
    parts.push(`cache saved ${meter.ttsCharsServedFromCache} chars`);
  }

  return `${parts.join(' | ') || 'no billable work'} => est. ₹${total.toFixed(2)}`;
}
