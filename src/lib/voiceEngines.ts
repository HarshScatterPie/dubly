import type { Voice, VoiceEngine } from '../types';

export const VOICE_ENGINES: VoiceEngine[] = ['gemini-flash-lite', 'gemini-flash', 'chirp'];

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
    description: 'Steady studio-grade Google Cloud voice for the major Indian languages; lines in other languages use Gemini 3.8 Flash.',
  },
};

// What a workspace with no plan setting gets: the cheapest engine only.
export const DEFAULT_VOICE_ENGINES: VoiceEngine[] = ['gemini-flash-lite'];

export function isVoiceEngine(value: unknown): value is VoiceEngine {
  return typeof value === 'string' && (VOICE_ENGINES as string[]).includes(value);
}

export function voiceAllowed(voice: Voice, engines: readonly VoiceEngine[]): boolean {
  return engines.includes(voice.engine);
}

/**
 * The voice a plan actually gets for a choice: the voice itself when its engine is allowed,
 * otherwise the same persona on an allowed engine (same timbre, cheaper model). A project
 * saved on a bigger plan, or a request naming a locked voice, keeps its voice's character
 * instead of failing.
 */
export function voiceForPlan(voice: Voice, engines: readonly VoiceEngine[], catalog: readonly Voice[]): Voice {
  if (voiceAllowed(voice, engines)) return voice;
  const allowed = catalog.filter((v) => voiceAllowed(v, engines));
  return (
    allowed.find((v) => v.providerVoice.vertex === voice.providerVoice.vertex) ??
    allowed.find((v) => v.gender === voice.gender) ??
    allowed[0] ??
    voice
  );
}
