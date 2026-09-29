import type { UserPreferences } from '../types';
import { VOICES } from './mockData';

// Ritu on Gemini 3.8 Flash-Lite, the engine every plan has. The old default, 'riya', named a voice the catalog no longer has, so dubs using it were refused.
export const DEFAULT_VOICE_ID = 'gemini-lite-aoede';

// A saved voice that no longer exists (a removed cloned voice, say) falls back to the default rather than failing the dub.
export function usableVoiceId(id: string | undefined): string {
  return id && VOICES.some((v) => v.id === id) ? id : DEFAULT_VOICE_ID;
}

// What a user gets before they change anything; shared by the server (stored settings) and the client (settings page, studio).
export const DEFAULT_PREFERENCES: UserPreferences = {
  defaultTargetLanguages: [],
  defaultVoiceId: DEFAULT_VOICE_ID,
  translationStyle: 'natural',
  adaptExpressions: true,
  voiceEmotion: 'friendly',
  voiceSpeed: 1,
  expressiveVoices: true,
  separateBackground: false,
  autoLipSync: false,
  burnCaptions: false,
  // Features that add to the provider bill start off; users switch on the ones they want.
  aiReview: false,
  premiumVoices: false,
  paceRetakes: false,
};

export function withPreferenceDefaults(saved: Partial<UserPreferences> | undefined | null): UserPreferences {
  const merged = { ...DEFAULT_PREFERENCES, ...(saved ?? {}) };
  return { ...merged, defaultVoiceId: usableVoiceId(merged.defaultVoiceId) };
}
