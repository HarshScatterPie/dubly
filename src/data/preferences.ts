import type { UserPreferences } from '../types';
import { VOICES } from './mockData';

// Ritu, a Hindi Chirp3-HD voice. The old default, 'riya', named a voice the catalog no longer has, so dubs using it were refused.
export const DEFAULT_VOICE_ID = 'google-hi-aoede';

// A saved voice that no longer exists falls back to the default rather than failing the dub; cloned voices are checked where the user's list is known.
export function usableVoiceId(id: string | undefined): string {
  return id && (id.startsWith('cloned:') || VOICES.some((v) => v.id === id)) ? id : DEFAULT_VOICE_ID;
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
};

export function withPreferenceDefaults(saved: Partial<UserPreferences> | undefined | null): UserPreferences {
  const merged = { ...DEFAULT_PREFERENCES, ...(saved ?? {}) };
  return { ...merged, defaultVoiceId: usableVoiceId(merged.defaultVoiceId) };
}
