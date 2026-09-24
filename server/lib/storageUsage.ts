import { bucket } from './firebaseAdmin';
import { HttpError } from './httpError';
import { limits } from './limits';

/**
 * A workspace's real storage use: the total size of the objects under workspaces/{id}/ in the bucket. This replaces the old
 * running counter, which added the source size once per rendered language and never went down on deletion. Listing the
 * prefix costs one API call per 1,000 objects, so the figure is cached briefly and refreshed after uploads and deletions.
 */
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { bytes: number; at: number }>();

export function invalidateStorageUsage(workspaceId: string): void {
  cache.delete(workspaceId);
}

export async function workspaceStorageBytes(workspaceId: string): Promise<number> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.bytes;
  const [files] = await bucket.getFiles({ prefix: `workspaces/${workspaceId}/`, autoPaginate: true });
  const bytes = files.reduce((sum, file) => sum + (Number(file.metadata?.size) || 0), 0);
  cache.set(workspaceId, { bytes, at: Date.now() });
  return bytes;
}

export const bytesToMb = (bytes: number) => Math.round((bytes / (1024 * 1024)) * 10) / 10;

// Refuses an upload that would take the workspace past its storage allowance, when enforcement is switched on.
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
