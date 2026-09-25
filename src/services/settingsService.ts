import { apiGet, apiPost, apiPut } from '../lib/apiClient';
import type { UserPreferences } from '../types';
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

  signOutEverywhere: () => apiPost<void>('/api/profile/sign-out-everywhere'),
};
