import type { DubbingProject, UserPreferences, UserUsageStats } from '../types';
import type { WorkspaceInfo } from '../services/workspaceService';
import type { UserProfile } from '../context/AuthContext';
import { ApiError, apiGet } from './apiClient';

// Everything the app opens with, as GET /api/bootstrap returns it.
export interface BootData {
  workspace: WorkspaceInfo;
  preferences: UserPreferences;
  usage: UserUsageStats;
  projects: DubbingProject[];
  profile: UserProfile | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The fields the screens read without checking: an answer without them would otherwise blank the sidebar or crash the page.
export function isUsageStats(value: unknown): value is UserUsageStats {
  return (
    isRecord(value) &&
    typeof value.minutesDubbed === 'number' &&
    typeof value.minutesLimit === 'number' &&
    typeof value.activePlan === 'string' &&
    typeof value.planId === 'string' &&
    Array.isArray(value.voiceEngines) &&
    isRecord(value.extraRates)
  );
}

export function isBootData(value: unknown): value is BootData {
  if (!isRecord(value) || !isRecord(value.workspace) || !isRecord(value.preferences)) return false;
  return typeof value.workspace.id === 'string' && Array.isArray(value.workspace.members) && isUsageStats(value.usage) && Array.isArray(value.projects);
}

const UNEXPECTED_ANSWER = 'Dubly sent an answer it should not have. Try again in a moment.';

/** The same check for any answer the app is about to rely on: one that fails counts as a failed request. */
export function assertAnswer<T>(value: unknown, valid: (value: unknown) => value is T): T {
  if (!valid(value)) throw new ApiError(UNEXPECTED_ANSWER, 502, 'BAD_RESPONSE');
  return value;
}

export const loadBootData = async () => assertAnswer(await apiGet<unknown>('/api/bootstrap'), isBootData);

// Per account, so one person's studio never opens with another's data; a week old at most, and always refreshed right after it is shown.
const FAMILY = 'dubly.boot.';
const PREFIX = `${FAMILY}v2.`;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Browsers allow about 5 MB per site; a list big enough to crowd that out is left to load from the server instead.
const MAX_CACHED_CHARS = 2_000_000;

// What must not sit in this browser's storage, which any script on the page can read: signed media links (each opens a file for
// hours) and email addresses. The first paint does without them; the fresh answer fills them in a moment later.
const SIGNED_LINK = /^\/api\/media\//;
const EMAIL_ADDRESS = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function withoutPrivateValues<T>(value: T): T {
  if (typeof value === 'string') return (SIGNED_LINK.test(value) || EMAIL_ADDRESS.test(value) ? '' : value) as T;
  if (Array.isArray(value)) return value.map(withoutPrivateValues) as T;
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, withoutPrivateValues(inner)])) as T;
  return value;
}

function removeKeys(matches: (key: string) => boolean): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && matches(key)) localStorage.removeItem(key);
    }
  } catch {
    // No storage, nothing cached.
  }
}

// Copies from before links and addresses were left out still hold them.
removeKeys((key) => key.startsWith(FAMILY) && !key.startsWith(PREFIX));

export function readBootCache(uid: string): BootData | null {
  try {
    const raw = localStorage.getItem(PREFIX + uid);
    if (!raw) return null;
    const { savedAt, data } = JSON.parse(raw) as { savedAt: number; data: unknown };
    if (isBootData(data) && Date.now() - savedAt <= MAX_AGE_MS) return data;
    localStorage.removeItem(PREFIX + uid);
    return null;
  } catch {
    return null;
  }
}

export function writeBootCache(uid: string, data: BootData): void {
  // Nothing that fails the check is kept: a bad copy would be what the next visit opens on.
  if (!isBootData(data)) return;
  try {
    const raw = JSON.stringify({ savedAt: Date.now(), data: withoutPrivateValues(data) });
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
  removeKeys((key) => key.startsWith(FAMILY));
}
