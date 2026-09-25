import type { DubbingProject, UserPreferences, UserUsageStats } from '../types';
import type { WorkspaceInfo } from '../services/workspaceService';
import type { UserProfile } from '../context/AuthContext';
import { apiGet } from './apiClient';

// Everything the app opens with, as GET /api/bootstrap returns it.
export interface BootData {
  workspace: WorkspaceInfo;
  preferences: UserPreferences;
  usage: UserUsageStats;
  projects: DubbingProject[];
  profile: UserProfile | null;
}

export const loadBootData = () => apiGet<BootData>('/api/bootstrap');

// Per account, so one person's studio never opens with another's data; a week old at most, and always refreshed right after it is shown.
const PREFIX = 'dubly.boot.v1.';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Browsers allow about 5 MB per site; a list big enough to crowd that out is left to load from the server instead.
const MAX_CACHED_CHARS = 2_000_000;

export function readBootCache(uid: string): BootData | null {
  try {
    const raw = localStorage.getItem(PREFIX + uid);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw) as { savedAt: number; data: BootData };
    if (!data?.workspace || Date.now() - savedAt > MAX_AGE_MS) return null;
    return data;
  } catch {
    return null;
  }
}

export function writeBootCache(uid: string, data: BootData): void {
  try {
    const raw = JSON.stringify({ savedAt: Date.now(), data });
    // Too big to keep: dropped rather than stored without projects, which would open on an empty list.
    if (raw.length > MAX_CACHED_CHARS) localStorage.removeItem(PREFIX + uid);
    else localStorage.setItem(PREFIX + uid, raw);
  } catch {
    // Full or blocked storage only means the next visit waits for the server.
  }
}

// Folds fresher pieces (the project list after a save, new usage) into the cached copy.
export function updateBootCache(uid: string, patch: Partial<BootData>): void {
  const current = readBootCache(uid);
  if (current) writeBootCache(uid, { ...current, ...patch });
}

// Signing out leaves nothing of any account's studio behind on this browser.
export function clearBootCaches(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key?.startsWith(PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    // No storage, nothing cached.
  }
}
