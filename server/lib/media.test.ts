import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ffmpegPath } from './mediaTools';
import {
  applyPitchSpeed,
  burnSubtitles,
  extractAudioClip,
  extractAudioForStt,
  extractAudioOnly,
  extractThumbnail,
  muxVideoWithAudio,
  probeMedia,
  splitAudioIntoChunks,
  stitchDubbedAudio,
} from './ffmpeg';
import { sniffContainer, validateMedia } from './mediaValidation';
import { buildKaraokeAss } from './captions';
import { detectSpeechRegions } from './forcedAlign';
import { limits } from './limits';
import { createUser, db, resetEmulators, startApi, type TestApi } from '../test/helpers';
import { bucket } from './firebaseAdmin';

let dir: string;
const f = (name: string) => path.join(dir, name);

function run(args: string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(ffmpegPath, ['-y', '-v', 'error', ...args], { windowsHide: true }, (err) => (err ? reject(err) : resolve()))
  );
}

const TONE = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000'];
const PICTURE = ['-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10'];

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dubly-media-'));
  await Promise.all([
    run([...PICTURE, ...TONE, '-t', '3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('video.mp4')]),
    run([...PICTURE, ...TONE, '-t', '2', '-c:v', 'libvpx-vp9', '-b:v', '100k', '-c:a', 'libopus', f('video.webm')]),
    run([...PICTURE, ...TONE, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', f('video.mkv')]),
    run([...PICTURE, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('silent.mp4')]),
    run([...PICTURE, ...TONE, '-t', '2', '-c:v', 'mpeg4', '-c:a', 'mp3', f('video.avi')]),
    run([...PICTURE, '-frames:v', '1', f('image.png')]),
    run([...TONE, '-t', '6', '-c:a', 'libopus', f('voice.webm')]),
    run([...TONE, '-t', '6', '-c:a', 'pcm_s16le', f('voice.wav')]),
    run(['-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=24000', '-t', '1', '-c:a', 'pcm_s16le', f('tts.wav')]),
  ]);
  const mp4 = await readFile(f('video.mp4'));
  await writeFile(f('truncated.mp4'), mp4.subarray(0, 2000));
  // A 44-byte WAV header with no samples: a "recording" with zero length.
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(0, 40);
  await writeFile(f('empty.wav'), header);
}, 120_000);

describe('media validation (by content, not by name)', () => {
  it.each([
    ['MP4', 'video.mp4', 'video/mp4', '.mp4'],
    ['WebM', 'video.webm', 'video/webm', '.webm'],
    ['Matroska', 'video.mkv', 'video/webm', '.webm'],
  ])('accepts %s video', async (_label, file, contentType, ext) => {
    const result = await validateMedia(f(file), 'video');
    expect(result.contentType).toBe(contentType);
    expect(result.ext).toBe(ext);
    expect(result.durationSeconds).toBeGreaterThan(1);
  });

  it('accepts browser-recorded (webm/opus) and wav voice samples as audio', async () => {
    expect((await validateMedia(f('voice.webm'), 'audio')).durationSeconds).toBeGreaterThan(5);
    expect((await validateMedia(f('voice.wav'), 'audio')).contentType).toBe('audio/wav');
  });

  it.each([
    ['an AVI file', 'video.avi', 'UNSUPPORTED_MEDIA'],
    ['an image renamed as video', 'image.png', 'UNSUPPORTED_MEDIA'],
    ['a truncated MP4', 'truncated.mp4', 'MEDIA_UNREADABLE'],
    ['a video with no sound', 'silent.mp4', 'NO_AUDIO_STREAM'],
    ['an audio-only file', 'voice.wav', 'UNSUPPORTED_MEDIA'],
  ])('rejects %s as a video', async (_label, file, code) => {
    await expect(validateMedia(f(file), 'video')).rejects.toMatchObject({ status: 400, code });
  });

  it('rejects a zero-length recording', async () => {
    await expect(validateMedia(f('empty.wav'), 'audio')).rejects.toMatchObject({ status: 400 });
  });

  describe('playlists and protocol tricks', () => {
    let server: http.Server;
    let hits = 0;
    beforeAll(async () => {
      server = http.createServer((_req, res) => {
        hits++;
        res.end('x');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
      const port = (server.address() as AddressInfo).port;
      const playlist = `#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:${port}/seg.ts\n#EXT-X-ENDLIST\n`;
      await writeFile(f('playlist.mp4'), playlist);
      await writeFile(f('playlist.m3u8'), playlist);
      await writeFile(f('concat.mp4'), `ffconcat version 1.0\nfile '${f('video.mp4').replace(/\\/g, '/')}'\n`);
    });
    afterAll(() => new Promise<void>((r) => server.close(() => r())));

    it('refuses a playlist or concat list disguised as a video, without fetching anything', async () => {
      await expect(validateMedia(f('playlist.mp4'), 'video')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
      await expect(validateMedia(f('concat.mp4'), 'video')).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA' });
      expect(hits).toBe(0);
    });

    it('keeps ffprobe itself from following a playlist to the network', async () => {
      await probeMedia(f('playlist.m3u8')).catch(() => undefined);
      expect(hits).toBe(0);
    });
  });

  it('sniffs containers from their first bytes', () => {
    expect(sniffContainer(Buffer.from('#EXTM3U\n'))).toBeNull();
    expect(sniffContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))).toBe('matroska');
    expect(sniffContainer(Buffer.from('\0\0\0\x18ftypisom', 'latin1'))).toBe('mp4');
    expect(sniffContainer(Buffer.alloc(0))).toBeNull();
  });
});

describe('every media step works on the bundled ffmpeg', () => {
  it('extracts STT audio, chunks it and cuts clips', async () => {
    await extractAudioForStt(f('video.mp4'), f('stt.wav'));
    const probe = await probeMedia(f('stt.wav'));
    expect(probe.durationSeconds).toBeGreaterThan(2.5);
    const chunks = await splitAudioIntoChunks(f('stt.wav'), 1, path.join(dir, 'chunks'));
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    await extractAudioClip(f('stt.wav'), 0.5, 1, f('clip.wav'));
    expect((await probeMedia(f('clip.wav'))).durationSeconds).toBeCloseTo(1, 0);
  });

  it('makes a thumbnail', async () => {
    await extractThumbnail(f('video.mp4'), f('thumb.jpg'), 0.3, 3);
    expect((await stat(f('thumb.jpg'))).size).toBeGreaterThan(100);
  });

  it('applies pitch and speed to a clip', async () => {
    const input = await readFile(f('tts.wav'));
    const shaped = await applyPitchSpeed(input, 1.1, 1.2, path.join(dir, 'pitch'));
    expect(shaped.length).toBeGreaterThan(44);
    expect(shaped.equals(input)).toBe(false);
  });

  it('stitches a dub over the source bed, muxes it, burns captions and exports mp3', async () => {
    const tts = await readFile(f('tts.wav'));
    const stitched = await stitchDubbedAudio({
      segments: [
        { startTime: 0.2, endTime: 1.0, audio: tts },
        { startTime: 1.5, endTime: 2.4, audio: tts },
      ],
      totalDurationSeconds: 3,
      pitch: 1,
      speed: 1,
      workDir: path.join(dir, 'stitch'),
      background: { path: f('video.mp4'), duckRegions: [{ start: 0.1, end: 1.1 }], duckLevel: 0 },
    });
    expect((await probeMedia(stitched)).durationSeconds).toBeCloseTo(3, 0);

    const silentOnly = await stitchDubbedAudio({ segments: [], totalDurationSeconds: 2, pitch: 1, speed: 1, workDir: path.join(dir, 'stitch-empty') });
    expect((await probeMedia(silentOnly)).durationSeconds).toBeCloseTo(2, 0);

    await muxVideoWithAudio(f('video.mp4'), stitched, f('dubbed.mp4'));
    const dubbed = await probeMedia(f('dubbed.mp4'));
    expect(dubbed.hasVideo && dubbed.hasAudio).toBe(true);

    const ass = buildKaraokeAss([
      { id: 'l1', segmentId: 's1', startTime: 0.2, endTime: 1.0, sourceText: 'hi', translatedText: 'नमस्ते दुनिया', isEdited: false },
    ] as never);
    await writeFile(f('captions.ass'), ass, 'utf8');
    await burnSubtitles(f('dubbed.mp4'), f('captions.ass'), f('captioned.mp4'));
    expect((await probeMedia(f('captioned.mp4'))).hasVideo).toBe(true);

    await extractAudioOnly(f('dubbed.mp4'), f('dubbed.mp3'));
    expect((await probeMedia(f('dubbed.mp3'))).hasAudio).toBe(true);
  }, 60_000);

  it('finds speech regions', async () => {
    const regions = await detectSpeechRegions(f('stt.wav'), 3);
    expect(Array.isArray(regions)).toBe(true);
  });
});

describe('POST /api/projects/:id/upload', () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await startApi();
  });
  afterAll(async () => {
    await api.close();
  });
  beforeEach(async () => {
    await resetEmulators();
  });

  async function upload(file: string, name: string, type = 'video/mp4') {
    const user = await createUser('uploader@team.test');
    const project = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'up' } });
    const form = new FormData();
    form.append('file', new Blob([await readFile(f(file))], { type }), name);
    const res = await fetch(`${api.baseUrl}/api/projects/${project.body.id}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.token}` },
      body: form,
    });
    return { res, body: await res.json(), user, projectId: project.body.id as string };
  }

  it('stores a real video under a name and type derived from its content', async () => {
    const { res, body, user, projectId } = await upload('video.webm', 'holiday.mp4', 'video/mp4');
    expect(res.status).toBe(200);
    expect(body.videoDuration).toBeGreaterThan(1);
    const wsId = (await api.call('GET', '/api/workspace', { token: user.token })).body.id;
    const stored = await db.collection('workspaces').doc(wsId).collection('projects').doc(projectId).get();
    expect(stored.get('videoStoragePath')).toBe(`workspaces/${wsId}/projects/${projectId}/source.webm`);
    const [meta] = await bucket.file(stored.get('videoStoragePath')).getMetadata();
    expect(meta.contentType).toBe('video/webm');
  });

  it('refuses a playlist disguised as an MP4 with a clear 400', async () => {
    const { res, body } = await upload('playlist.mp4', 'clip.mp4');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('UNSUPPORTED_MEDIA');
  });

  it(`refuses videos longer than the limit`, async () => {
    const saved = limits.maxVideoSeconds;
    limits.maxVideoSeconds = 2;
    try {
      const { res, body } = await upload('video.mp4', 'long.mp4');
      expect(res.status).toBe(400);
      expect(body.error.code).toBe('VIDEO_TOO_LONG');
    } finally {
      limits.maxVideoSeconds = saved;
    }
  });

  it('refuses a damaged file', async () => {
    const { res, body } = await upload('truncated.mp4', 'broken.mp4');
    expect(res.status).toBe(400);
    expect(body.error.code).toBe('MEDIA_UNREADABLE');
  });
});
