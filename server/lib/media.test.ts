import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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
} from './ffmpeg';
import { stitchDubbedAudio } from './dubMix';
import { sniffContainer, validateMedia } from './mediaValidation';
import { buildKaraokeAss } from './captions';
import { detectSpeechRegions, speechBetweenSilences, type SilenceEvent } from './forcedAlign';
import { limits } from './limits';
import { createUser, readProject, resetEmulators, startApi, type TestApi } from '../test/helpers';
import { fileExists, findStoredFile } from './mediaStore';
import { col } from './mongo';
import { sweepExpiredRecords } from './recordSweeper';

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

    const noBed = await stitchDubbedAudio({
      segments: [{ startTime: 0.5, endTime: 1.5, audio: tts }],
      totalDurationSeconds: 3,
      pitch: 1.05,
      speed: 1.1,
      workDir: path.join(dir, 'stitch-no-bed'),
    });
    expect((await probeMedia(noBed)).durationSeconds).toBeCloseTo(3, 0);

    await muxVideoWithAudio(f('video.mp4'), stitched, f('dubbed.mp4'));
    const dubbed = await probeMedia(f('dubbed.mp4'));
    expect(dubbed.hasVideo && dubbed.hasAudio).toBe(true);

    const ass = buildKaraokeAss([
      { id: 'l1', segmentId: 's1', startTime: 0.2, endTime: 1.0, sourceText: 'hi', translatedText: 'नमस्ते दुनिया', isEdited: false },
    ] as never);
    await writeFile(f('captions.ass'), ass, 'utf8');
    await burnSubtitles(f('dubbed.mp4'), f('captions.ass'), f('captioned.mp4'));
    expect((await probeMedia(f('captioned.mp4'))).hasVideo).toBe(true);

    // A quote in the folder name (a Windows account called O'Connor, say) must not end the filter's quoted path.
    const quoted = f("O'Connor dir");
    await mkdir(quoted);
    await writeFile(path.join(quoted, 'captions.ass'), ass, 'utf8');
    await burnSubtitles(f('dubbed.mp4'), path.join(quoted, 'captions.ass'), f('captioned-quoted.mp4'));
    expect((await probeMedia(f('captioned-quoted.mp4'))).hasVideo).toBe(true);

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

  describe('in chunks', () => {
    const savedChunkBytes = limits.uploadChunkBytes;
    afterAll(() => {
      limits.uploadChunkBytes = savedChunkBytes;
    });

    // A file split in three, and an open upload for it.
    async function openUpload(file = 'video.webm', name = 'big.webm') {
      const bytes = await readFile(f(file));
      limits.uploadChunkBytes = Math.ceil(bytes.length / 3);
      const user = await createUser('chunks@team.test');
      const project = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'up' } });
      const projectId = project.body.id as string;
      const opened = await api.call('POST', `/api/projects/${projectId}/uploads`, { token: user.token, body: { fileName: name, size: bytes.length, contentType: 'video/webm' } });
      expect(opened.status).toBe(201);
      const uploadId = opened.body.uploadId as string;
      const chunkBytes = opened.body.chunkBytes as number;
      const put = (index: number, body: Buffer = bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes), token = user.token) =>
        fetch(`${api.baseUrl}/api/projects/${projectId}/uploads/${uploadId}/chunks/${index}`, {
          method: 'PUT',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(body),
        });
      const complete = () => api.call('POST', `/api/projects/${projectId}/uploads/${uploadId}/complete`, { token: user.token });
      return { bytes, user, projectId, uploadId, put, complete };
    }

    it('makes the same project as one upload, whatever order the chunks arrive in', async () => {
      const { bytes, user, projectId, uploadId, put, complete } = await openUpload();
      for (const index of [2, 0, 1]) expect((await put(index)).status).toBe(204);

      const res = await complete();

      expect(res.status).toBe(200);
      expect(res.body.videoDuration).toBeGreaterThan(1);
      const wsId = (await api.call('GET', '/api/workspace', { token: user.token })).body.id;
      const stored = await readProject(wsId, projectId);
      expect(stored?.videoStoragePath).toBe(`workspaces/${wsId}/projects/${projectId}/source.webm`);
      expect((await findStoredFile(stored!.videoStoragePath!))?.length).toBe(bytes.length);
      // Nothing of the upload is left behind.
      expect(await fileExists(`uploads/${uploadId}/0`)).toBe(false);
      expect(await col('uploadSessions').countDocuments({ _id: uploadId as never })).toBe(0);
    });

    it('takes a chunk again, replacing the first attempt', async () => {
      const { put, complete } = await openUpload();
      for (const index of [0, 0, 1, 2, 2]) expect((await put(index)).status).toBe(204);
      expect((await complete()).status).toBe(200);
    });

    it('refuses a chunk of the wrong size or number', async () => {
      const { put } = await openUpload();
      const short = await put(0, Buffer.from('too short'));
      expect(short.status).toBe(400);
      expect((await short.json()).error.code).toBe('BAD_CHUNK');
      expect((await put(9, Buffer.from('x'))).status).toBe(400);
    });

    it('says when a chunk is missing, and can still be finished', async () => {
      const { put, complete } = await openUpload();
      await put(0);
      await put(2);
      const early = await complete();
      expect(early.status).toBe(400);
      expect(early.body.error.code).toBe('UPLOAD_INCOMPLETE');
      await put(1);
      expect((await complete()).status).toBe(200);
    });

    it('judges the whole file by its content, and drops an upload that fails', async () => {
      const { uploadId, put, complete } = await openUpload('playlist.mp4', 'clip.mp4');
      for (const index of [0, 1, 2]) await put(index);
      expect((await complete()).status).toBe(400);
      expect(await col('uploadSessions').countDocuments({ _id: uploadId as never })).toBe(0);
    });

    it("hides another workspace's upload", async () => {
      const { put, projectId, uploadId } = await openUpload();
      const stranger = await createUser('stranger-chunks@team.test');
      expect((await put(0, undefined, stranger.token)).status).toBe(404);
      expect((await api.call('POST', `/api/projects/${projectId}/uploads/${uploadId}/complete`, { token: stranger.token })).status).toBe(404);
    });

    it('refuses to open an upload over the size limit', async () => {
      const user = await createUser('huge@team.test');
      const project = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'up' } });
      const res = await api.call('POST', `/api/projects/${project.body.id}/uploads`, { token: user.token, body: { fileName: 'a.mp4', size: 600 * 1024 * 1024 } });
      expect(res.status).toBe(413);
    });

    it('sweeps an upload nobody finished, chunks and all', async () => {
      const { uploadId, put } = await openUpload();
      await put(0);
      expect(await fileExists(`uploads/${uploadId}/0`)).toBe(true);
      await sweepExpiredRecords(Date.now() + 7 * 60 * 60 * 1000);
      expect(await fileExists(`uploads/${uploadId}/0`)).toBe(false);
      expect(await col('uploadSessions').countDocuments({ _id: uploadId as never })).toBe(0);
    });
  });

  it('stores a real video under a name and type derived from its content', async () => {
    const { res, body, user, projectId } = await upload('video.webm', 'holiday.mp4', 'video/mp4');
    expect(res.status).toBe(200);
    expect(body.videoDuration).toBeGreaterThan(1);
    const wsId = (await api.call('GET', '/api/workspace', { token: user.token })).body.id;
    const stored = await readProject(wsId, projectId);
    expect(stored?.videoStoragePath).toBe(`workspaces/${wsId}/projects/${projectId}/source.webm`);
    const file = await findStoredFile(stored!.videoStoragePath!);
    expect(file?.metadata?.contentType).toBe('video/webm');
    expect(file?.metadata?.sha256).toMatch(/^[a-f0-9]{64}$/);
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

describe('speech between silences', () => {
  const start = (time: number): SilenceEvent => ({ type: 'start', time });
  const end = (time: number): SilenceEvent => ({ type: 'end', time });

  it('takes the gaps between paired silences, including at both edges of the clip', () => {
    const events = [start(0), end(2), start(5), end(7), start(10), end(12)];
    expect(speechBetweenSilences(events, 12)).toEqual([
      { start: 2, end: 5 },
      { start: 7, end: 10 },
    ]);
  });

  it('reads an end with no start as a clip that opened in silence, without shifting what follows', () => {
    expect(speechBetweenSilences([end(2), start(5), end(7)], 10)).toEqual([
      { start: 2, end: 5 },
      { start: 7, end: 10 },
    ]);
  });

  it('reads a start with no end as a clip that closed in silence, not as speech', () => {
    expect(speechBetweenSilences([start(5)], 10)).toEqual([{ start: 0, end: 5 }]);
  });

  it('treats a clip with no silence as all speech, and one that is all silence as none', () => {
    expect(speechBetweenSilences([], 10)).toEqual([{ start: 0, end: 10 }]);
    expect(speechBetweenSilences([start(0), end(10)], 10)).toEqual([]);
  });
});
