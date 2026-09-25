import { describe, expect, it } from 'vitest';
import { allowanceRate, effectiveExtras, NO_EXTRAS } from '../../src/lib/planMath';
import { DEFAULT_PLANS, toPlan } from './plans';

const prefs = { aiReview: true, premiumVoices: true, paceRetakes: true, expressiveVoices: true };

describe('plan maths', () => {
  it('gives no extras on a plan without them, and premium voices and re-takes only with expressive voices', () => {
    expect(effectiveExtras(false, prefs)).toEqual(NO_EXTRAS);
    expect(effectiveExtras(true, prefs)).toEqual({ aiReview: true, premiumVoices: true, paceRetakes: true });
    expect(effectiveExtras(true, { ...prefs, expressiveVoices: false })).toEqual({ aiReview: true, premiumVoices: false, paceRetakes: false });
  });

  it('turns the extras switched on into how fast a dubbed minute uses the allowance', () => {
    const rates = DEFAULT_PLANS.enterprise.extraRates;
    expect(allowanceRate(rates, NO_EXTRAS)).toBe(1);
    expect(allowanceRate(rates, { ...NO_EXTRAS, aiReview: true })).toBe(1.25);
    expect(allowanceRate(rates, effectiveExtras(true, prefs))).toBe(2);
    expect(allowanceRate({ aiReview: -3 }, { ...NO_EXTRAS, aiReview: true })).toBe(1);
  });

  it('reads a hand-edited plan defensively, keeping built-in values for broken fields', () => {
    expect(toPlan('enterprise', { minutesPerMonth: 200, extraRates: { aiReview: 0.1 } })).toMatchObject({
      name: 'Enterprise',
      minutesPerMonth: 200,
      extraRates: { aiReview: 0.1, premiumVoices: 0.5, paceRetakes: 0.25 },
      teamInvites: true,
    });
    expect(toPlan('starter', { minutesPerMonth: 'lots', paidExtras: 'yes' })).toMatchObject({ minutesPerMonth: 50, paidExtras: false });
  });
});
