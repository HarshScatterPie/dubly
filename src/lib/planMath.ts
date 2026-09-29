import type { PaidExtra, UserPreferences, VoiceEngine } from '../types';
import { hasGeminiVoices, premiumVoicesOffered } from './voiceEngines';

export const PAID_EXTRAS: PaidExtra[] = ['aiReview', 'premiumVoices', 'paceRetakes'];

export type PaidExtrasChoice = Record<PaidExtra, boolean>;

export const NO_EXTRAS: PaidExtrasChoice = { aiReview: false, premiumVoices: false, paceRetakes: false };

// The extras a dub really gets: none on a plan without them, re-takes only with expressive Gemini voices, and premium voices only on top of Gemini 3.8 ones.
export function effectiveExtras(allowed: boolean, prefs: Pick<UserPreferences, PaidExtra | 'expressiveVoices'>, engines: readonly VoiceEngine[]): PaidExtrasChoice {
  if (!allowed) return { ...NO_EXTRAS };
  const expressiveGemini = prefs.expressiveVoices && hasGeminiVoices(engines);
  return {
    aiReview: Boolean(prefs.aiReview),
    premiumVoices: Boolean(prefs.premiumVoices && expressiveGemini && premiumVoicesOffered(engines)),
    paceRetakes: Boolean(prefs.paceRetakes && expressiveGemini),
  };
}

// How much monthly allowance one dubbed minute uses with these extras on: 1 with none, 1.5 with extras adding up to 0.5.
export function allowanceRate(rates: Partial<Record<PaidExtra, number>>, extras: PaidExtrasChoice): number {
  const extra = PAID_EXTRAS.reduce((sum, key) => sum + (extras[key] ? Math.max(0, Number(rates[key]) || 0) : 0), 0);
  return Math.round((1 + extra) * 100) / 100;
}
