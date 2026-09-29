import type { Voice, VoiceEngine } from '../types';

// Every engine a persona can be voiced on, in catalog order.
export const VOICE_ENGINES: VoiceEngine[] = ['gemini-flash-lite', 'gemini-flash', 'chirp', 'gemini-2.5-flash'];

// The engines each TTS_ENGINE setting offers: Gemini 3.8 through the Gemini API, or only what Google Cloud TTS serves.
export const GEMINI_API_ENGINES: VoiceEngine[] = ['gemini-flash-lite', 'gemini-flash', 'chirp'];
export const CLOUD_ENGINES: VoiceEngine[] = ['gemini-2.5-flash', 'chirp'];

export const VOICE_ENGINE_INFO: Record<VoiceEngine, { label: string; description: string }> = {
  'gemini-flash-lite': {
    label: 'Gemini 3.8 Flash-Lite',
    description: 'Expressive Gemini voice that follows emotion and delivery; speaks every Indian language and dialect.',
  },
  'gemini-flash': {
    label: 'Gemini 3.8 Flash',
    description: 'Gemini’s richest voice: fuller emotion, laughs and sighs; speaks every Indian language and dialect.',
  },
  chirp: {
    label: 'Chirp 3 HD',
    description: 'Steady studio-grade Google Cloud voice for the major Indian languages; other languages are read by a Gemini voice where there is one, otherwise by a related language’s voice.',
  },
  'gemini-2.5-flash': {
    label: 'Gemini 2.5 Flash',
    description: 'Expressive Google Cloud voice that follows emotion and delivery; dialects are read by a related language’s voice, such as Bhojpuri by a Hindi voice.',
  },
};

// What a workspace with no plan setting gets: the cheapest engine only.
export const DEFAULT_VOICE_ENGINES: VoiceEngine[] = ['gemini-flash-lite'];

// Languages Cloud TTS has no Chirp 3 HD voice for, not even a related language's (checked 2026-09-29), and the Gemini engines that speak them.
const GEMINI_ONLY_LANGUAGES: Record<string, VoiceEngine[]> = {
  or: ['gemini-flash-lite', 'gemini-flash', 'gemini-2.5-flash'],
  sat: ['gemini-flash-lite', 'gemini-flash'],
};

export function isVoiceEngine(value: unknown): value is VoiceEngine {
  return typeof value === 'string' && (VOICE_ENGINES as string[]).includes(value);
}

/** Whether any of these engines is a Gemini one: delivery direction and re-takes only change Gemini voices. */
export function hasGeminiVoices(engines: readonly VoiceEngine[]): boolean {
  return engines.some((engine) => engine !== 'chirp');
}

/** Whether premium voices (Gemini 3.1, tried before a Gemini 3.8 voice's own model) can apply. */
export function premiumVoicesOffered(engines: readonly VoiceEngine[]): boolean {
  return engines.some((engine) => engine === 'gemini-flash-lite' || engine === 'gemini-flash');
}

/** Whether a voice on these engines can speak the language at all. */
export function languageVoiced(code: string, engines: readonly VoiceEngine[]): boolean {
  const speakers = GEMINI_ONLY_LANGUAGES[code];
  return !speakers || engines.some((engine) => speakers.includes(engine));
}

/**
 * The engines whose voices pickers list: those of the setting the server runs, the ones
 * outside the plan shown locked. With only Chirp 3 HD there is nothing to lock.
 */
export function listedEngines(engines: readonly VoiceEngine[]): VoiceEngine[] {
  if (engines.includes('gemini-2.5-flash')) return CLOUD_ENGINES;
  return premiumVoicesOffered(engines) ? GEMINI_API_ENGINES : [...engines];
}

/** "Gemini 2.5 Flash", or "Gemini 3.8 Flash-Lite and Chirp 3 HD": the voices a plan includes, for messages. */
export function enginesLabel(engines: readonly VoiceEngine[]): string {
  return engines.map((engine) => VOICE_ENGINE_INFO[engine].label).join(' and ');
}

export function voiceAllowed(voice: Voice, engines: readonly VoiceEngine[]): boolean {
  return engines.includes(voice.engine);
}

/**
 * The voice a plan actually gets for a choice: the voice itself when its engine is allowed,
 * otherwise the same persona on an allowed engine (same timbre), a Gemini one for a Gemini
 * voice so it stays expressive. A project saved on a bigger plan, or a request naming a locked
 * voice, keeps its voice's character instead of failing.
 */
export function voiceForPlan(voice: Voice, engines: readonly VoiceEngine[], catalog: readonly Voice[]): Voice {
  if (voiceAllowed(voice, engines)) return voice;
  const allowed = catalog.filter((v) => voiceAllowed(v, engines));
  const samePersona = allowed.filter((v) => v.providerVoice.vertex === voice.providerVoice.vertex);
  return (
    samePersona.find((v) => (v.engine === 'chirp') === (voice.engine === 'chirp')) ??
    samePersona[0] ??
    allowed.find((v) => v.gender === voice.gender) ??
    allowed[0] ??
    voice
  );
}
