import path from 'node:path';
import { readdir, rm, stat } from 'node:fs/promises';
import { tmpDir } from './paths';

// Scratch areas that per-request work creates entries in; anything older than the cutoff there is left over from a crash.
const SCRATCH_SUBDIRS = ['jobs', 'uploads', 'tts', 'voice-uploads', 'voice-jobs', 'clone'];
export const DEFAULT_TMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Deletes scratch entries under server/tmp older than `maxAgeMs`, skipping `keep` (paths still in use). Loose files at the
 * top of tmp (VAD scratch, ad-hoc test output) are swept too. Returns what was removed.
 */
export async function sweepTmp(options: { root?: string; maxAgeMs?: number; keep?: ReadonlySet<string>; now?: number } = {}): Promise<string[]> {
  const root = options.root ?? tmpDir;
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_TMP_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const keep = new Set([...(options.keep ?? [])].map((p) => path.resolve(p)));
  const removed: string[] = [];

  const consider = async (entry: string) => {
    const full = path.resolve(entry);
    if (keep.has(full)) return;
    try {
      const info = await stat(full);
      if (now - info.mtimeMs < maxAgeMs) return;
      await rm(full, { recursive: true, force: true });
      removed.push(full);
    } catch {
      // Already gone, or in use by the OS; the next sweep tries again.
    }
  };

  const list = async (dir: string) => readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of await list(root)) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory() && SCRATCH_SUBDIRS.includes(entry.name)) {
      for (const child of await list(full)) await consider(path.join(full, child.name));
    } else if (entry.isFile()) {
      await consider(full);
    }
  }
  return removed;
}
