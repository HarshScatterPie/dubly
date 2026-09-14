import admin from 'firebase-admin';
import { loadServiceAccount } from './credentials';
import { env } from './env';

const serviceAccount = loadServiceAccount('firebase-service-account.json') as admin.ServiceAccount;

const app = admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  storageBucket: env.firebaseStorageBucket,
});

export const db = admin.firestore();
// Several call sites merge partial updates that may legitimately include `undefined`
// (e.g. clearing currentProcessingMessage) — without this, the Admin SDK throws.
db.settings({ ignoreUndefinedProperties: true });
export const bucket = admin.storage().bucket();
export const authAdmin = admin.auth();

export { app as firebaseAdminApp };

/**
 * Storage URLs are never persisted directly — only the storage path is stored in
 * Firestore, and a fresh signed URL is minted on read so links can't silently expire
 * while a project sits untouched.
 *
 * Minting a signed URL bakes an `expires` timestamp into its query string, so calling
 * this fresh on every read (as before) produced a *different* URL each time for the same
 * unchanged file — defeating the browser's HTTP cache entirely and forcing a full
 * re-download of the video/audio on every single page load. Reusing the same URL for a
 * bounded window lets the browser actually cache the media across visits, which is the
 * real fix for slow repeat loads (GCS signing itself is fast local RSA signing, not the
 * bottleneck). The reuse window is intentionally shorter than the signed URL's own 6-day
 * validity, matched to the response Cache-Control below, so a re-dub that overwrites a
 * mutable path (e.g. dubbed.mp4) is only stale for at most that window.
 */
const SIGNED_URL_CACHE_MS = 1000 * 60 * 55; // under an hour, matched to the Cache-Control max-age below
const signedUrlCache = new Map<string, { url: string; cachedAt: number }>();

export async function getSignedDownloadUrl(
  storagePath: string,
  expiresInMs = 1000 * 60 * 60 * 24 * 6
): Promise<string> {
  const cached = signedUrlCache.get(storagePath);
  if (cached && Date.now() - cached.cachedAt < SIGNED_URL_CACHE_MS) {
    return cached.url;
  }

  const file = bucket.file(storagePath);
  const [url] = await file.getSignedUrl({
    action: 'read',
    expires: Date.now() + expiresInMs,
    queryParams: { 'response-cache-control': 'private, max-age=3300' },
  });
  signedUrlCache.set(storagePath, { url, cachedAt: Date.now() });
  return url;
}

/** Call after overwriting or deleting an object at a mutable path (e.g. a re-dub) so the next read mints a fresh URL instead of serving the up-to-55-minute-old cached one. */
export function invalidateSignedUrlCache(storagePath: string): void {
  signedUrlCache.delete(storagePath);
}

export async function uploadBufferToStorage(
  storagePath: string,
  buffer: Buffer,
  contentType: string
): Promise<void> {
  const file = bucket.file(storagePath);
  await file.save(buffer, { contentType, resumable: false });
}

export async function uploadFileToStorage(
  storagePath: string,
  localFilePath: string,
  contentType: string
): Promise<void> {
  await bucket.upload(localFilePath, {
    destination: storagePath,
    contentType,
  });
}
