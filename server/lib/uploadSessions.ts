import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { HttpError } from './httpError';
import { limits } from './limits';
import { assembleStoredFiles, deleteStoredPrefix, fileExists, uploadStreamToStorage } from './mediaStore';
import { col } from './mongo';

/**
 * A large video sent in pieces. A front door can refuse any one request over a size (Cloudflare's is 100 MB), and one dropped connection
 * should not cost a 500 MB upload, so the browser sends chunks and retries only the one that failed. Chunks go to shared storage, not this
 * process's disk, because the next one may land on another process. They sit outside the workspace's folder, so they count against
 * its storage only once the file is whole.
 */
export interface UploadSession {
  _id: string;
  workspaceId: string;
  projectId: string;
  fileName: string;
  size: number;
  chunkBytes: number;
  expiresAt: Date;
}

// Long enough for a slow connection; an abandoned upload's chunks are swept after this.
const UPLOAD_SESSION_MS = 6 * 60 * 60 * 1000;

const sessions = () => col<UploadSession>('uploadSessions');
const chunkFolder = (uploadId: string) => `uploads/${uploadId}/`;
const chunkPath = (uploadId: string, index: number) => `${chunkFolder(uploadId)}${index}`;

export const chunkCount = (session: Pick<UploadSession, 'size' | 'chunkBytes'>) => Math.ceil(session.size / session.chunkBytes);
export const expectedChunkBytes = (session: Pick<UploadSession, 'size' | 'chunkBytes'>, index: number) => Math.min(session.chunkBytes, session.size - index * session.chunkBytes);

export async function startUpload(input: Pick<UploadSession, 'workspaceId' | 'projectId' | 'fileName' | 'size'>): Promise<UploadSession> {
  const session: UploadSession = { _id: randomUUID(), ...input, chunkBytes: limits.uploadChunkBytes, expiresAt: new Date(Date.now() + UPLOAD_SESSION_MS) };
  await sessions().insertOne(session);
  return session;
}

// Another workspace's upload looks exactly like a missing one.
export async function findUpload(workspaceId: string, projectId: string, uploadId: string): Promise<UploadSession | null> {
  return sessions().findOne({ _id: uploadId, workspaceId, projectId });
}

/** Stores one chunk, replacing an earlier attempt at it. Throws when the body is not exactly the size this chunk must be. */
export async function storeChunk(session: UploadSession, index: number, body: Readable): Promise<void> {
  await uploadStreamToStorage(chunkPath(session._id, index), body, 'application/octet-stream', expectedChunkBytes(session, index));
}

/** Joins the chunks into one local file, checking each against the checksum it was stored with. */
export async function assembleUpload(session: UploadSession, destination: string): Promise<void> {
  const paths = Array.from({ length: chunkCount(session) }, (_, index) => chunkPath(session._id, index));
  const present = await Promise.all(paths.map(fileExists));
  if (present.includes(false)) throw new HttpError(400, 'UPLOAD_INCOMPLETE', 'Part of this upload is missing. Please try again.');
  await assembleStoredFiles(paths, destination);
}

export async function discardUpload(session: Pick<UploadSession, '_id'>): Promise<void> {
  await deleteStoredPrefix(chunkFolder(session._id));
  await sessions().deleteOne({ _id: session._id });
}

/** Removes uploads nobody finished, chunks and all. */
export async function sweepExpiredUploads(now = Date.now(), batch = 100): Promise<number> {
  const expired = await sessions().find({ expiresAt: { $lt: new Date(now) } }, { projection: { _id: 1 } }).limit(batch).toArray();
  for (const session of expired) await discardUpload(session);
  return expired.length;
}
