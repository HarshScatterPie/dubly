import type { PaidExtra, UserPreferences } from '../types';

export const PAID_EXTRAS: PaidExtra[] = ['aiReview', 'premiumVoices', 'paceRetakes'];

export type PaidExtrasChoice = Record<PaidExtra, boolean>;

export const NO_EXTRAS: PaidExtrasChoice = { aiReview: false, premiumVoices: false, paceRetakes: false };

// The extras a dub really gets: none on a plan without them, and premium voices and re-takes only with expressive voices, the only engine they change.
export function effectiveExtras(allowed: boolean, prefs: Pick<UserPreferences, PaidExtra | 'expressiveVoices'>): PaidExtrasChoice {
  if (!allowed) return { ...NO_EXTRAS };
  return {
    aiReview: Boolean(prefs.aiReview),
    premiumVoices: Boolean(prefs.premiumVoices && prefs.expressiveVoices),
    paceRetakes: Boolean(prefs.paceRetakes && prefs.expressiveVoices),
  };
}

// How much monthly allowance one dubbed minute uses with these extras on: 1 with none, 1.5 with extras adding up to 0.5.
export function allowanceRate(rates: Partial<Record<PaidExtra, number>>, extras: PaidExtrasChoice): number {
  const extra = PAID_EXTRAS.reduce((sum, key) => sum + (extras[key] ? Math.max(0, Number(rates[key]) || 0) : 0), 0);
  return Math.round((1 + extra) * 100) / 100;
}
