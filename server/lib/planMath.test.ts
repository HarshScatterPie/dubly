import { describe, expect, it } from 'vitest';
import { allowanceRate, effectiveExtras, NO_EXTRAS } from '../../src/lib/planMath';
import { CLOUD_ENGINES, GEMINI_API_ENGINES, languageVoiced, listedEngines, VOICE_ENGINES, voiceAllowed, voiceForPlan } from '../../src/lib/voiceEngines';
import { VOICES } from '../../src/data/mockData';
import { env } from './env';
import { DEFAULT_PLANS, toPlan, withOfferedEngines } from './plans';

const prefs = { aiReview: true, premiumVoices: true, paceRetakes: true, expressiveVoices: true };

describe('plan maths', () => {
  it('gives no extras on a plan without them, and premium voices and re-takes only with expressive Gemini voices', () => {
    expect(effectiveExtras(false, prefs, VOICE_ENGINES)).toEqual(NO_EXTRAS);
    expect(effectiveExtras(true, prefs, VOICE_ENGINES)).toEqual({ aiReview: true, premiumVoices: true, paceRetakes: true });
    expect(effectiveExtras(true, { ...prefs, expressiveVoices: false }, VOICE_ENGINES)).toEqual({ aiReview: true, premiumVoices: false, paceRetakes: false });
    // Chirp 3 HD alone: nothing for premium voices or re-takes to change, so neither is charged.
    expect(effectiveExtras(true, prefs, ['chirp'])).toEqual({ aiReview: true, premiumVoices: false, paceRetakes: false });
  });

  it('turns the extras switched on into how fast a dubbed minute uses the allowance', () => {
    const rates = DEFAULT_PLANS.enterprise.extraRates;
    expect(allowanceRate(rates, NO_EXTRAS)).toBe(1);
    expect(allowanceRate(rates, { ...NO_EXTRAS, aiReview: true })).toBe(1.25);
    expect(allowanceRate(rates, effectiveExtras(true, prefs, VOICE_ENGINES))).toBe(2);
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

  it('gives each plan the closest engines the server offers', () => {
    const previous = env.ttsEngine;
    try {
      env.ttsEngine = 'gemini';
      expect(withOfferedEngines(DEFAULT_PLANS.enterprise).voiceEngines).toEqual(['gemini-flash-lite', 'gemini-flash', 'chirp']);
      expect(withOfferedEngines(DEFAULT_PLANS.starter).voiceEngines).toEqual(['gemini-flash-lite']);
      // Google Cloud only: Gemini 3.8 voices become Gemini 2.5 Flash, and Chirp 3 HD stays an Enterprise voice.
      env.ttsEngine = 'cloud';
      expect(withOfferedEngines(DEFAULT_PLANS.enterprise).voiceEngines).toEqual(['gemini-2.5-flash', 'chirp']);
      expect(withOfferedEngines(DEFAULT_PLANS.starter).voiceEngines).toEqual(['gemini-2.5-flash']);
      env.ttsEngine = 'chirp';
      expect(withOfferedEngines(DEFAULT_PLANS.enterprise).voiceEngines).toEqual(['chirp']);
      // Starter has no Chirp of its own; it gets the offered engine rather than none.
      expect(withOfferedEngines(DEFAULT_PLANS.starter).voiceEngines).toEqual(['chirp']);
    } finally {
      env.ttsEngine = previous;
    }
  });
});

describe('languages and voices on each server setting', () => {
  it('offers Odia only with a Gemini voice that speaks it, and Santali only with Gemini 3.8', () => {
    expect(languageVoiced('or', ['chirp'])).toBe(false);
    expect(languageVoiced('sat', ['chirp'])).toBe(false);
    expect(languageVoiced('bho', ['chirp'])).toBe(true);
    expect(languageVoiced('or', ['gemini-flash-lite'])).toBe(true);
    expect(languageVoiced('or', ['gemini-2.5-flash'])).toBe(true);
    expect(languageVoiced('sat', ['gemini-2.5-flash', 'chirp'])).toBe(false);
  });

  it('lists the voices of the setting the server runs, and nothing it could not unlock', () => {
    expect(listedEngines(['chirp'])).toEqual(['chirp']);
    expect(listedEngines(['gemini-flash-lite'])).toEqual(GEMINI_API_ENGINES);
    expect(listedEngines(['gemini-2.5-flash'])).toEqual(CLOUD_ENGINES);
  });

  it('charges premium voices only on top of Gemini 3.8 voices', () => {
    expect(effectiveExtras(true, prefs, ['gemini-2.5-flash', 'chirp'])).toEqual({ aiReview: true, premiumVoices: false, paceRetakes: true });
  });
});

describe('voices on a plan', () => {
  const byId = (id: string) => VOICES.find((v) => v.id === id)!;

  it('offers every persona on every engine, keeping the saved Chirp 3 HD ids', () => {
    expect(VOICES).toHaveLength(120);
    expect(byId('google-hi-aoede').engine).toBe('chirp');
    expect(byId('gemini-lite-aoede').engine).toBe('gemini-flash-lite');
    expect(byId('gemini-flash-aoede').engine).toBe('gemini-flash');
    expect(byId('gemini-25-aoede').engine).toBe('gemini-2.5-flash');
    expect(new Set(VOICES.map((v) => v.id)).size).toBe(VOICES.length);
  });

  it('voices a saved Gemini 3.8 voice as the same persona on Gemini 2.5 Flash, not on the steady Chirp 3 HD', () => {
    expect(voiceForPlan(byId('gemini-lite-aoede'), ['gemini-2.5-flash'], VOICES).id).toBe('gemini-25-aoede');
    expect(voiceForPlan(byId('gemini-lite-aoede'), ['gemini-2.5-flash', 'chirp'], VOICES).id).toBe('gemini-25-aoede');
    expect(voiceForPlan(byId('google-hi-aoede'), ['gemini-2.5-flash'], VOICES).id).toBe('gemini-25-aoede');
  });

  it('voices a locked voice as the same persona on an engine the plan has', () => {
    const starter = DEFAULT_PLANS.starter.voiceEngines;
    expect(voiceAllowed(byId('google-hi-aoede'), starter)).toBe(false);
    expect(voiceForPlan(byId('google-hi-aoede'), starter, VOICES).id).toBe('gemini-lite-aoede');
    expect(voiceForPlan(byId('gemini-flash-charon'), starter, VOICES).id).toBe('gemini-lite-charon');
    expect(voiceForPlan(byId('google-hi-aoede'), DEFAULT_PLANS.enterprise.voiceEngines, VOICES).id).toBe('google-hi-aoede');
  });
});
