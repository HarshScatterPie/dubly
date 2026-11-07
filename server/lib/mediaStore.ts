import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable, Transform, type TransformCallback } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { GridFSBucket, type GridFSFile, type ObjectId } from 'mongodb';
import { sharedInvalidator } from './cacheBus';
import { col, mongoDb } from './mongo';

/**
 * Every stored file (source videos, thumbnails, dubbed audio and video, separated stems, captioned exports) lives in MongoDB
 * GridFS, bucket `media`, under its storage path as the filename (`workspaces/{ws}/projects/{id}/...`). Records store paths,
 * never URLs; a reader gets a short-lived signed URL to this server (`/api/media/...`, served by routes/media.ts with HTTP
 * Range support, so players can seek).
 *
 * Writes are crash-safe: a new version is written completely first and only then are older versions of the same path removed,
 * so a reader always finds a whole file. Each file records its SHA-256, and downloads verify it.
 */
const BUCKET_NAME = 'media';
// 1 MiB chunks: a 500 MB video is 500 chunk documents, and a seek reads at most one chunk it does not need.
const CHUNK_BYTES = 1024 * 1024;

export interface MediaMetadata {
  contentType: string;
  sha256: string;
  workspaceId?: string;
}
export type MediaFile = GridFSFile & { metadata?: MediaMetadata };

let bucketInstance: { db: unknown; bucket: GridFSBucket } | null = null;
function bucket(): GridFSBucket {
  const db = mongoDb();
  if (!bucketInstance || bucketInstance.db !== db) bucketInstance = { db, bucket: new GridFSBucket(db, { bucketName: BUCKET_NAME, chunkSizeBytes: CHUNK_BYTES }) };
  return bucketInstance.bucket;
}

const filesCol = () => mongoDb().collection<MediaFile>(`${BUCKET_NAME}.files`);

export async function ensureMediaIndexes(): Promise<void> {
  // GridFS makes its own (filename, uploadDate) and chunk indexes on first write; these are created up front so reads use them from the start.
  await filesCol().createIndexes([
    { key: { filename: 1, uploadDate: -1 }, name: 'filename_1_uploadDate_-1' },
    { key: { 'metadata.workspaceId': 1 }, name: 'workspace' },
  ]);
  await mongoDb().collection(`${BUCKET_NAME}.chunks`).createIndex({ files_id: 1, n: 1 }, { unique: true, name: 'files_id_1_n_1' });
}

function workspaceOf(storagePath: string): string | undefined {
  const match = /^workspaces\/([^/]+)\//.exec(storagePath);
  return match?.[1];
}

function assertStoragePath(storagePath: string): void {
  if (!storagePath || storagePath.startsWith('/') || storagePath.split('/').some((part) => part === '..' || part === '') || /[\0\\]/.test(storagePath)) {
    throw new Error(`Invalid storage path: ${storagePath}`);
  }
}

// Counts bytes and hashes them on their way into GridFS.
class Hasher extends Transform {
  hash = createHash('sha256');
  bytes = 0;
  _transform(chunk: Buffer, _enc: BufferEncoding, done: TransformCallback): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    done(null, chunk);
  }
}

async function writeFrom(storagePath: string, source: Readable, contentType: string, expectedBytes: number): Promise<void> {
  assertStoragePath(storagePath);
  const hasher = new Hasher();
  // The checksum is only known at the end, so it is added to the file document once the upload completes.
  const upload = bucket().openUploadStream(storagePath, { metadata: { contentType, sha256: '', workspaceId: workspaceOf(storagePath) } });
  try {
    await pipeline(source, hasher, upload);
  } catch (err) {
    await bucket().delete(upload.id as ObjectId).catch(() => undefined);
    throw err;
  }
  if (hasher.bytes !== expectedBytes) {
    await bucket().delete(upload.id as ObjectId).catch(() => undefined);
    throw new Error(`Upload of ${storagePath} stored ${hasher.bytes} of ${expectedBytes} bytes`);
  }
  await filesCol().updateOne({ _id: upload.id as ObjectId }, { $set: { 'metadata.sha256': hasher.hash.digest('hex') } });
  // Only now that the new version is whole are the older ones removed.
  const older = await filesCol()
    .find({ filename: storagePath, _id: { $ne: upload.id as ObjectId } }, { projection: { _id: 1 } })
    .toArray();
  for (const file of older) await bucket().delete(file._id).catch(() => undefined);
  invalidateSignedUrlCache(storagePath);
}

export async function uploadFileToStorage(storagePath: string, localFilePath: string, contentType: string): Promise<void> {
  const { size } = await stat(localFilePath);
  await writeFrom(storagePath, createReadStream(localFilePath), contentType, size);
}

export async function uploadBufferToStorage(storagePath: string, buffer: Buffer, contentType: string): Promise<void> {
  await writeFrom(storagePath, Readable.from([buffer]), contentType, buffer.length);
}

/** Stores a stream that must be exactly `expectedBytes` long, stopping as soon as it runs over rather than taking whatever is sent. */
export async function uploadStreamToStorage(storagePath: string, source: Readable, contentType: string, expectedBytes: number): Promise<void> {
  async function* capped(): AsyncGenerator<Buffer> {
    let bytes = 0;
    for await (const chunk of source as AsyncIterable<Buffer>) {
      bytes += chunk.length;
      if (bytes > expectedBytes) throw new Error(`Upload of ${storagePath} ran past ${expectedBytes} bytes`);
      yield chunk;
    }
  }
  await writeFrom(storagePath, Readable.from(capped(), { objectMode: false }), contentType, expectedBytes);
}

// A player seeking through a video sends many range requests for the same file; its record is kept briefly instead of read for each.
// Every write and delete clears the entry in every process (invalidateSignedUrlCache), so a re-render is not served stale.
const FILE_CACHE_MS = 30_000;
const fileCache = new Map<string, { file: MediaFile; at: number }>();
// Bumped by every invalidation: a lookup that was already reading when a path changed does not cache what it read.
let fileCacheEpoch = 0;

// The newest complete version stored under a path (an upload in progress has no checksum yet and is not served).
export async function findStoredFile(storagePath: string): Promise<MediaFile | null> {
  const hit = fileCache.get(storagePath);
  if (hit && Date.now() - hit.at < FILE_CACHE_MS) return hit.file;
  const epoch = fileCacheEpoch;
  const file = await filesCol().findOne({ filename: storagePath, 'metadata.sha256': { $nin: ['', null] } }, { sort: { uploadDate: -1 } });
  if (file && epoch === fileCacheEpoch) {
    if (fileCache.size >= 2000) fileCache.clear();
    fileCache.set(storagePath, { file, at: Date.now() });
  } else if (!file) {
    fileCache.delete(storagePath);
  }
  return file;
}

export async function fileExists(storagePath: string): Promise<boolean> {
  return (await findStoredFile(storagePath)) !== null;
}

export class StoredFileMissingError extends Error {
  constructor(public storagePath: string) {
    super(`No stored file at ${storagePath}`);
  }
}

/** Copies a stored file to a local path (ffmpeg only ever reads local files), verifying its checksum. */
export async function downloadFileFromStorage(storagePath: string, destination: string): Promise<void> {
  const file = await findStoredFile(storagePath);
  if (!file) throw new StoredFileMissingError(storagePath);
  const hasher = new Hasher();
  await pipeline(bucket().openDownloadStream(file._id), hasher, createWriteStream(destination));
  const expected = file.metadata?.sha256;
  if (hasher.bytes !== file.length || (expected && hasher.hash.digest('hex') !== expected)) {
    throw new Error(`Stored file ${storagePath} failed its integrity check`);
  }
}

/** Joins stored files, in order, into one local file, verifying each one's checksum on the way. */
export async function assembleStoredFiles(storagePaths: string[], destination: string): Promise<void> {
  async function* pieces() {
    for (const storagePath of storagePaths) {
      const file = await findStoredFile(storagePath);
      if (!file) throw new StoredFileMissingError(storagePath);
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of bucket().openDownloadStream(file._id) as AsyncIterable<Buffer>) {
        hash.update(chunk);
        bytes += chunk.length;
        yield chunk;
      }
      if (bytes !== file.length || hash.digest('hex') !== file.metadata?.sha256) throw new Error(`Stored file ${storagePath} failed its integrity check`);
    }
  }
  await pipeline(pieces, createWriteStream(destination));
}

/** A stream of a stored file's bytes; `end` is inclusive, like an HTTP Range. */
export function openStoredFileStream(file: MediaFile, range?: { start: number; end: number }): Readable {
  return bucket().openDownloadStream(file._id, range ? { start: range.start, end: range.end + 1 } : undefined);
}

export async function deleteStoredFile(storagePath: string): Promise<void> {
  const files = await filesCol().find({ filename: storagePath }, { projection: { _id: 1 } }).toArray();
  for (const file of files) await bucket().delete(file._id).catch(() => undefined);
  invalidateSignedUrlCache(storagePath);
}

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Removes every file whose path starts with `prefix` (a project's folder when it is deleted). */
export async function deleteStoredPrefix(prefix: string): Promise<number> {
  if (!prefix.endsWith('/')) throw new Error('A prefix delete needs a folder path ending in "/"');
  assertStoragePath(prefix.slice(0, -1));
  const files = await filesCol()
    .find({ filename: { $regex: `^${escapeRegex(prefix)}` } }, { projection: { _id: 1, filename: 1 } })
    .toArray();
  for (const file of files) {
    await bucket().delete(file._id).catch(() => undefined);
    invalidateSignedUrlCache(file.filename);
  }
  return files.length;
}

/** Bytes stored under a path prefix, e.g. a workspace's whole folder. */
export async function storedBytesUnder(prefix: string): Promise<number> {
  const [row] = await filesCol()
    .aggregate<{ bytes: number }>([{ $match: { filename: { $regex: `^${escapeRegex(prefix)}` } } }, { $group: { _id: null, bytes: { $sum: '$length' } } }])
    .toArray();
  return row?.bytes ?? 0;
}

// --- Signed media URLs ---------------------------------------------------------------------------------------------------

// The signing key: MEDIA_URL_SECRET when set, otherwise one generated on first use and kept in the database, so URLs survive restarts.
let signingKey: Promise<Buffer> | null = null;
function key(): Promise<Buffer> {
  signingKey ??= (async () => {
    if (process.env.MEDIA_URL_SECRET) return Buffer.from(process.env.MEDIA_URL_SECRET, 'utf8');
    const system = col<{ _id: string; value: string }>('system');
    await system.updateOne({ _id: 'mediaUrlKey' }, { $setOnInsert: { value: randomBytes(32).toString('base64') } }, { upsert: true });
    const doc = await system.findOne({ _id: 'mediaUrlKey' });
    return Buffer.from(doc!.value, 'base64');
  })().catch((err) => {
    signingKey = null;
    throw err;
  });
  return signingKey;
}

// Test seam: forgets the key when the database is wiped.
export function resetMediaKeyForTests(): void {
  signingKey = null;
  signedUrlCache.clear();
  fileCache.clear();
  bucketInstance = null;
}

const sealKey = (k: Buffer) => createHmac('sha256', k).update('media-path-seal').digest();

// The path in a media URL is sealed, so a link says nothing about workspaces, projects or accounts. Its IV comes from the path, so
// a path always seals to the same text: the URL stays stable for the browser's cache, and nothing but "same file" can be learned.
// Repeating an IV only harms GCM with different plaintext, and here different paths get different IVs short of a 96-bit HMAC collision.
function sealPath(k: Buffer, storagePath: string): string {
  const iv = createHmac('sha256', k).update(`iv\n${storagePath}`).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', sealKey(k), iv);
  const body = Buffer.concat([cipher.update(storagePath, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

function openPath(k: Buffer, sealed: string): string | null {
  try {
    const raw = Buffer.from(sealed, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', sealKey(k), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function signature(k: Buffer, storagePath: string, expiresSec: number, downloadName: string): string {
  return createHmac('sha256', k).update(`${storagePath}\n${expiresSec}\n${downloadName}`).digest('base64url');
}

async function sign(storagePath: string, expiresAtMs: number, downloadName = ''): Promise<string> {
  assertStoragePath(storagePath);
  const expiresSec = Math.floor(expiresAtMs / 1000);
  const k = await key();
  const sig = signature(k, storagePath, expiresSec, downloadName);
  const dl = downloadName ? `&dl=${encodeURIComponent(downloadName)}` : '';
  return `/api/media/${sealPath(k, storagePath)}?e=${expiresSec}${dl}&s=${sig}`;
}

export interface VerifiedMediaRequest {
  storagePath: string;
  expiresAtMs: number;
  downloadName: string;
}

/** Checks a media URL's signature and expiry; null for anything forged, altered or expired. */
export async function verifyMediaUrl(encodedPath: string, query: Record<string, unknown>, now = Date.now()): Promise<VerifiedMediaRequest | null> {
  const e = Number(query.e);
  const s = typeof query.s === 'string' ? query.s : '';
  const dl = typeof query.dl === 'string' ? query.dl : '';
  if (!Number.isInteger(e) || !s || e * 1000 <= now) return null;
  const k = await key();
  const storagePath = openPath(k, encodedPath);
  if (!storagePath) return null;
  try {
    assertStoragePath(storagePath);
  } catch {
    return null;
  }
  const expected = Buffer.from(signature(k, storagePath, e, dl));
  const given = Buffer.from(s);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return { storagePath, expiresAtMs: e * 1000, downloadName: dl };
}

/**
 * A URL is reused for a while instead of minted fresh on every read: a fresh one would differ every time (its expiry is in it),
 * defeating the browser's cache and re-downloading the video on every page load. The reuse window is shorter than the URL's
 * own 3-hour life, and matches the Cache-Control the media route sends.
 */
export const SIGNED_URL_CACHE_MS = 1000 * 60 * 55;
// Media URLs live 3 h (each reused for at most 55 min), so removed members and leaked links lose access within hours.
export const SIGNED_URL_TTL_MS = 1000 * 60 * 60 * 3;
const signedUrlCache = new Map<string, { url: string; cachedAt: number }>();

export async function getSignedDownloadUrl(storagePath: string, expiresInMs = SIGNED_URL_TTL_MS): Promise<string> {
  const cached = signedUrlCache.get(storagePath);
  if (cached && Date.now() - cached.cachedAt < SIGNED_URL_CACHE_MS) return cached.url;
  const url = await sign(storagePath, Date.now() + expiresInMs);
  if (signedUrlCache.size > 5000) signedUrlCache.clear();
  signedUrlCache.set(storagePath, { url, cachedAt: Date.now() });
  return url;
}

// An uncached URL with an explicit expiry, optionally offered as a download under `downloadName` (share pages).
export async function signReadUrl(storagePath: string, expiresAtMs: number, downloadName?: string): Promise<string> {
  return sign(storagePath, expiresAtMs, downloadName ?? '');
}

/** Call after overwriting or deleting a path, so the next read mints a fresh URL and finds the new version (its id, and so its ETag, change). */
export const invalidateSignedUrlCache = sharedInvalidator('media', (storagePath) => {
  if (storagePath === null) {
    signedUrlCache.clear();
    fileCache.clear();
    fileCacheEpoch++;
    return;
  }
  signedUrlCache.delete(storagePath);
  forgetStoredFile(storagePath);
});

/** Drops only the remembered file record (its signed URL stays valid), e.g. when reading the version it named failed. */
export function forgetStoredFile(storagePath: string): void {
  fileCache.delete(storagePath);
  fileCacheEpoch++;
}
