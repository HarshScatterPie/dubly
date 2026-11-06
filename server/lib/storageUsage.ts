import { storedBytesUnder } from './mediaStore';
import { HttpError } from './httpError';
import { limits } from './limits';

// A workspace's storage is the total size of its files in GridFS, cached briefly and refreshed after uploads and deletions.
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { bytes: number; at: number }>();

export function invalidateStorageUsage(workspaceId: string): void {
  cache.delete(workspaceId);
}

export async function workspaceStorageBytes(workspaceId: string): Promise<number> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bytes;
  const bytes = await storedBytesUnder(`workspaces/${workspaceId}/`);
  cache.set(workspaceId, { bytes, at: Date.now() });
  return bytes;
}

export const bytesToMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

// Refuses an upload that would take the workspace past its storage allowance (unless ENFORCE_STORAGE_LIMIT=false).
export async function assertStorageAvailable(workspaceId: string, incomingBytes: number): Promise<void> {
  if (!limits.enforceStorageLimit) return;
  const used = await workspaceStorageBytes(workspaceId);
  const limitBytes = limits.storageLimitMb * 1024 * 1024;
  if (used + incomingBytes > limitBytes) {
    throw new HttpError(
      413,
      'STORAGE_LIMIT_REACHED',
      `This workspace has used ${bytesToMb(used)} MB of its ${limits.storageLimitMb} MB storage. Delete old projects to make room.`
    );
  }
}
