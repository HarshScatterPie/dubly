import { apiGet, apiPatch, apiPost, apiPut } from '../lib/apiClient';
import type { UserPreferences } from '../types';
import type { UserProfile } from '../context/AuthContext';
import { withPreferenceDefaults } from '../data/preferences';

interface SettingsResponse {
  preferences?: Partial<UserPreferences>;
}

// Defaults kept by the Settings modal before preferences moved to the account; read once, then moved to the server.
const LEGACY_PREFS_KEY = 'dubly:dubbing-preferences';

function takeLegacyPreferences(): Partial<UserPreferences> | null {
  try {
    const raw = localStorage.getItem(LEGACY_PREFS_KEY);
    if (!raw) return null;
    const old = JSON.parse(raw) as { defaultVoice?: string; defaultStyle?: UserPreferences['translationStyle']; adaptExpressions?: boolean };
    return {
      ...(old.defaultVoice ? { defaultVoiceId: old.defaultVoice } : {}),
      ...(old.defaultStyle ? { translationStyle: old.defaultStyle } : {}),
      ...(typeof old.adaptExpressions === 'boolean' ? { adaptExpressions: old.adaptExpressions } : {}),
    };
  } catch {
    return null;
  }
}

// Whether this browser still holds pre-account preferences that getPreferences would move to the account.
export function hasLegacyPreferences(): boolean {
  try {
    return localStorage.getItem(LEGACY_PREFS_KEY) !== null;
  } catch {
    return false;
  }
}

export const settingsService = {
  async getPreferences(): Promise<UserPreferences> {
    const legacy = takeLegacyPreferences();
    if (legacy) {
      // Saved to the account first, and only then forgotten locally, so a failed request loses nothing.
      const saved = await apiPut<SettingsResponse>('/api/settings', { preferences: legacy });
      try {
        localStorage.removeItem(LEGACY_PREFS_KEY);
      } catch {
        // Storage can be unavailable (private mode); the migration simply runs again next time.
      }
      return withPreferenceDefaults(saved.preferences);
    }
    return withPreferenceDefaults((await apiGet<SettingsResponse>('/api/settings')).preferences);
  },

  async savePreferences(preferences: Partial<UserPreferences>): Promise<UserPreferences> {
    return withPreferenceDefaults((await apiPut<SettingsResponse>('/api/settings', { preferences })).preferences);
  },

  // Saves the name and/or picture (`avatar: null` removes it) shown across Dubly; returns the profile as it now reads.
  saveProfile: (patch: { name?: string; avatar?: string | null }) => apiPatch<UserProfile>('/api/profile', patch),

  signOutEverywhere: () => apiPost<void>('/api/profile/sign-out-everywhere'),
};

// Turns a picked image into the small square picture that is stored: centre-cropped, shrunk to 192px, JPEG. A few KB, so it can ride along
// with the team list and the app's startup data instead of needing file storage of its own.
export const AVATAR_PIXELS = 192;
export const MAX_AVATAR_SOURCE_BYTES = 12 * 1024 * 1024;

export async function avatarFromFile(file: File): Promise<string> {
  if (!/^image\/(jpeg|png|webp|gif|heic|heif|avif)$/.test(file.type)) throw new Error('Choose a JPEG, PNG or WebP picture.');
  if (file.size > MAX_AVATAR_SOURCE_BYTES) throw new Error('That picture is too large. Choose one under 12 MB.');
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That picture could not be opened. Try a JPEG or PNG.');
  });
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = AVATAR_PIXELS;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Your browser could not prepare the picture.');
    // A white backdrop, as JPEG has no transparency (a transparent PNG would otherwise turn black).
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, AVATAR_PIXELS, AVATAR_PIXELS);
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_PIXELS, AVATAR_PIXELS);
    return canvas.toDataURL('image/jpeg', 0.85);
  } finally {
    bitmap.close();
  }
}
