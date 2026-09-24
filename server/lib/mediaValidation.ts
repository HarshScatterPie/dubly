import { open } from 'node:fs/promises';
import { HttpError } from './httpError';
import { probeMedia, type MediaProbe } from './ffmpeg';

export type MediaKind = 'video' | 'audio';
type Container = 'mp4' | 'matroska' | 'wav' | 'mp3' | 'ogg' | 'flac';

// Containers accepted per upload kind, and ffprobe's demuxer names for each; anything else (playlists, concat lists, images, AVI…) is refused.
const ALLOWED: Record<MediaKind, Container[]> = {
  video: ['mp4', 'matroska'],
  audio: ['mp4', 'matroska', 'wav', 'mp3', 'ogg', 'flac'],
};
const DEMUXERS: Record<Container, string[]> = {
  mp4: ['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2'],
  matroska: ['matroska', 'webm'],
  wav: ['wav'],
  mp3: ['mp3'],
  ogg: ['ogg'],
  flac: ['flac'],
};
const STORAGE: Record<Container, { ext: string; contentType: string }> = {
  mp4: { ext: '.mp4', contentType: 'video/mp4' },
  matroska: { ext: '.webm', contentType: 'video/webm' },
  wav: { ext: '.wav', contentType: 'audio/wav' },
  mp3: { ext: '.mp3', contentType: 'audio/mpeg' },
  ogg: { ext: '.ogg', contentType: 'audio/ogg' },
  flac: { ext: '.flac', contentType: 'audio/flac' },
};

// Identifies the container from the file's first bytes, so a renamed text file or playlist never reaches ffprobe as a "video".
export function sniffContainer(head: Buffer): Container | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
  if (head.length >= 12 && ['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(4, 8))) return 'mp4';
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return 'matroska';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') return 'wav';
  if (ascii(0, 3) === 'ID3' || (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(0, 4) === 'OggS') return 'ogg';
  if (ascii(0, 4) === 'fLaC') return 'flac';
  return null;
}

async function readHead(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r');
  try {
    const buf = Buffer.alloc(32);
    const { bytesRead } = await handle.read(buf, 0, 32, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

const unsupported = (kind: MediaKind) =>
  new HttpError(
    400,
    'UNSUPPORTED_MEDIA',
    kind === 'video' ? 'Only MP4, MOV and WebM videos are supported.' : 'Upload an audio recording (wav, mp3, m4a, ogg, flac or webm).'
  );

/**
 * Decides from the file's content (never its name, extension or the browser's MIME type) whether an upload is a supported
 * video or audio file with real playable length, and returns the probe plus the storage extension/content type to use.
 */
export async function validateMedia(filePath: string, kind: MediaKind): Promise<MediaProbe & { ext: string; contentType: string }> {
  const container = sniffContainer(await readHead(filePath));
  if (!container || !ALLOWED[kind].includes(container)) throw unsupported(kind);

  let probe: MediaProbe;
  try {
    probe = await probeMedia(filePath);
  } catch {
    throw new HttpError(400, 'MEDIA_UNREADABLE', 'That file could not be read. It may be damaged; try exporting it again.');
  }
  const demuxers = probe.formatName.split(',').filter(Boolean);
  if (demuxers.length === 0 || !demuxers.every((d) => DEMUXERS[container].includes(d))) throw unsupported(kind);
  if (kind === 'video' && !probe.hasVideo) throw new HttpError(400, 'NO_VIDEO_STREAM', 'That file has no video picture in it.');
  if (!probe.hasAudio) {
    throw new HttpError(400, 'NO_AUDIO_STREAM', kind === 'video' ? 'That video has no sound to dub.' : 'That recording has no sound in it.');
  }
  if (!(probe.durationSeconds > 0)) throw new HttpError(400, 'MEDIA_UNREADABLE', 'That file has no playable length.');
  return { ...probe, ...STORAGE[container] };
}
