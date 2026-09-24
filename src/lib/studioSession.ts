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

export function rememberStudioProject(uid: string, projectId: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ uid, projectId }));
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
    const saved = JSON.parse(localStorage.getItem(KEY) || 'null') as { uid?: string; projectId?: string } | null;
    return saved?.uid === uid && saved.projectId ? saved.projectId : null;
  } catch {
    return null;
  }
}
