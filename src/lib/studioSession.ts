// What the dubbing studio is doing right now, reported up so the mini player can show it while the user is elsewhere in Dubly.
export interface StudioStatus {
  projectId: string | null;
  title: string;
  /** The finished dub once there is one, otherwise the source video. */
  videoUrl: string | null;
  label: string;
  /** 0-100 while a job reports progress, otherwise null. */
  progress: number | null;
  /** Upload, analysis, translation or a dub in flight. */
  busy: boolean;
  done: boolean;
}

// The open studio project, remembered per account so a reload or a crashed tab can bring it back.
const KEY = 'dubly:studio-session';

// Which account saved it, as a short one-way tag (FNV-1a): enough to tell accounts apart on one browser, without keeping the
// account id itself in the browser's storage.
function accountTag(uid: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < uid.length; i++) {
    hash ^= uid.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

export function rememberStudioProject(uid: string, projectId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ owner: accountTag(uid), projectId }));
  } catch {
    // Storage can be unavailable (private mode); the studio then just is not restored after a reload.
  }
}

export function forgetStudioProject(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Nothing to forget without storage.
  }
}

export function recalledStudioProject(uid: string): string | null {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as { owner?: string; projectId?: string } | null;
    return saved?.owner === accountTag(uid) && saved.projectId ? saved.projectId : null;
  } catch {
    return null;
  }
}
