import { describe, expect, it } from 'vitest';
import { allowanceRate, effectiveExtras, NO_EXTRAS } from '../../src/lib/planMath';
import { voiceAllowed, voiceForPlan } from '../../src/lib/voiceEngines';
import { VOICES } from '../../src/data/mockData';
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

  it('gives Starter Gemini 3.8 Flash-Lite voices only, and Enterprise every engine', () => {
    expect(toPlan('starter', undefined).voiceEngines).toEqual(['gemini-flash-lite']);
    expect(toPlan('enterprise', undefined).voiceEngines).toEqual(['gemini-flash-lite', 'gemini-flash', 'chirp']);
    // Hand-edited: unknown names dropped, and a list left empty keeps the built-in one rather than voicing nothing.
    expect(toPlan('starter', { voiceEngines: ['gemini-flash-lite', 'chirp', 'nope'] }).voiceEngines).toEqual(['gemini-flash-lite', 'chirp']);
    expect(toPlan('starter', { voiceEngines: ['nope'] }).voiceEngines).toEqual(['gemini-flash-lite']);
  });
});

describe('voices on a plan', () => {
  const byId = (id: string) => VOICES.find((v) => v.id === id)!;

  it('offers every persona on every engine, keeping the saved Chirp 3 HD ids', () => {
    expect(VOICES).toHaveLength(90);
    expect(byId('google-hi-aoede').engine).toBe('chirp');
    expect(byId('gemini-lite-aoede').engine).toBe('gemini-flash-lite');
    expect(byId('gemini-flash-aoede').engine).toBe('gemini-flash');
    expect(new Set(VOICES.map((v) => v.id)).size).toBe(VOICES.length);
    // The fallback voice must be one every plan can use.
    expect(VOICES[0].engine).toBe('gemini-flash-lite');
  });

  it('voices a locked voice as the same persona on an engine the plan has', () => {
    const starter = DEFAULT_PLANS.starter.voiceEngines;
    expect(voiceAllowed(byId('google-hi-aoede'), starter)).toBe(false);
    expect(voiceForPlan(byId('google-hi-aoede'), starter, VOICES).id).toBe('gemini-lite-aoede');
    expect(voiceForPlan(byId('gemini-flash-charon'), starter, VOICES).id).toBe('gemini-lite-charon');
    expect(voiceForPlan(byId('google-hi-aoede'), DEFAULT_PLANS.enterprise.voiceEngines, VOICES).id).toBe('google-hi-aoede');
  });
});
