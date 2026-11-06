import type { Request, Response } from 'express';
import { Router } from '../lib/router';
import { findStoredFile, openStoredFileStream, verifyMediaUrl } from '../lib/mediaStore';
import { rateLimit } from '../lib/rateLimit';
import { rateRules } from '../lib/limits';
import { log } from '../lib/log';

/**
 * Serves stored files from MongoDB GridFS to players and downloads. Mounted without a session: a URL's signature (minted by
 * mediaStore.getSignedDownloadUrl for a signed-in member, or by a share link) is the permission, and it expires within hours.
 * Supports HTTP Range requests, so a video can seek and start playing before it has downloaded.
 */
export const mediaRouter = Router();

// What a stored file may be served as. Anything else goes out as a download of opaque bytes, never as something a browser renders.
const SERVABLE_TYPES = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska', 'audio/wav', 'audio/x-wav', 'audio/mp4', 'audio/mpeg', 'audio/ogg', 'audio/webm', 'image/jpeg', 'image/png', 'image/webp']);

type ByteRange = { start: number; end: number };

// One `bytes=` range (players never ask for more than one); null when absent or multi-part, 'invalid' when it cannot be met.
export function parseRange(header: string | undefined, size: number): ByteRange | null | 'invalid' {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return header.includes(',') ? null : 'invalid';
  const [, from, to] = match;
  if (from === '' && to === '') return 'invalid';
  if (from === '') {
    // A suffix: the last N bytes.
    const suffix = Number(to);
    if (suffix <= 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return 'invalid';
  return { start, end };
}

function contentDisposition(downloadName: string): string {
  const ascii = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
}

async function serve(req: Request, res: Response): Promise<void> {
  const verified = await verifyMediaUrl(req.params.path, req.query as Record<string, unknown>);
  if (!verified) {
    res.status(403).type('text/plain').setHeader('Cache-Control', 'no-store').send('This media link is invalid or has expired.');
    return;
  }
  const file = await findStoredFile(verified.storagePath);
  if (!file) {
    res.status(404).type('text/plain').setHeader('Cache-Control', 'no-store').send('Not found');
    return;
  }

  const size = file.length;
  const contentType = file.metadata?.contentType && SERVABLE_TYPES.has(file.metadata.contentType) ? file.metadata.contentType : 'application/octet-stream';
  // Each stored version has its own id, so a re-render changes the ETag and a cached copy is never mistaken for the new one.
  const etag = `"${file._id.toHexString()}"`;
  // Cached privately, never past the URL's own expiry; `no-transform` keeps the compression middleware off already-compressed media.
  const maxAge = Math.max(0, Math.min(3300, Math.floor((verified.expiresAtMs - Date.now()) / 1000)));
  res.setHeader('Cache-Control', `private, max-age=${maxAge}, no-transform`);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', file.uploadDate.toUTCString());
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  if (verified.downloadName || contentType === 'application/octet-stream') {
    res.setHeader('Content-Disposition', contentDisposition(verified.downloadName || 'download'));
  }

  if (req.headers['if-none-match'] === etag) {
    res.status(304).end();
    return;
  }

  // If-Range: a range only applies while the file is still the version the client started with.
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, size);
  if (range === 'invalid') {
    res.setHeader('Content-Range', `bytes */${size}`);
    res.status(416).end();
    return;
  }

  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
  } else {
    res.status(200);
    res.setHeader('Content-Length', String(size));
  }
  if (req.method === 'HEAD' || size === 0) {
    res.end();
    return;
  }

  const stream = openStoredFileStream(file, range ?? undefined);
  // A player that seeks or closes the tab aborts its request; the database read stops with it.
  res.on('close', () => stream.destroy());
  stream.on('error', (err) => {
    if (!res.headersSent) res.status(500).end();
    else res.destroy(err);
    if ((err as NodeJS.ErrnoException).code !== 'ERR_STREAM_PREMATURE_CLOSE') log.error('media_stream_failed', err, { storagePath: verified.storagePath });
  });
  stream.pipe(res);
}

const limited = rateLimit('media', [['ip', rateRules.mediaPerIp]]);
mediaRouter.get('/:path', limited, serve);
mediaRouter.head('/:path', limited, serve);
