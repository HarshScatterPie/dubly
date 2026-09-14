/**
 * Rough per-render cost accounting, so spend is visible instead of only showing up on a
 * bill at the end of the month.
 *
 * These are published list prices converted to INR, not a billing integration — they
 * ignore free tiers and any negotiated rate, so treat the numbers as an upper-bound
 * estimate of what a render costs rather than an invoice.
 */
const USD_TO_INR = 83;

// Google Cloud TTS list prices per 1M characters.
const GOOGLE_CHIRP3_HD_PER_1M_USD = 30;
// Sarvam Bulbul v3: ₹30 per 10K characters.
const SARVAM_TTS_PER_1K_INR = 3;
// Sarvam Saaras: ₹30 per hour of audio.
const SARVAM_STT_PER_HOUR_INR = 30;
// Gemini 2.5 Flash audio input, ~$1.00 per 1M tokens at roughly 32 audio tokens/second.
const GEMINI_AUDIO_TOKENS_PER_SECOND = 32;
const GEMINI_AUDIO_PER_1M_TOKENS_USD = 1;

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
  if (provider === 'sarvam') return (chars / 1000) * SARVAM_TTS_PER_1K_INR;
  if (provider === 'vertex') return (chars / 1_000_000) * GOOGLE_CHIRP3_HD_PER_1M_USD * USD_TO_INR;
  return 0;
}

function sttCostInr(provider: string, seconds: number): number {
  if (provider === 'sarvam') return (seconds / 3600) * SARVAM_STT_PER_HOUR_INR;
  if (provider === 'vertex') {
    const tokens = seconds * GEMINI_AUDIO_TOKENS_PER_SECOND;
    return (tokens / 1_000_000) * GEMINI_AUDIO_PER_1M_TOKENS_USD * USD_TO_INR;
  }
  return 0;
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
