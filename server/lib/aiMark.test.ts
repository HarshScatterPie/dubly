import { beforeAll, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ffmpegPath } from './mediaTools';
import { burnSubtitles, embedSubtitleTrack, muxVideoWithAudio, probeMedia, probeMediaTags } from './ffmpeg';
import { AI_LABEL_PATH, appendAiXmp, newAiMark } from './aiMark';
import { DEFAULT_PLANS, toPlan } from './plans';

const run = promisify(execFile);
let dir: string;
const f = (name: string) => path.join(dir, name);
const ffmpeg = (args: string[]) => run(ffmpegPath, ['-y', '-v', 'error', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'buffer' });

// One grey frame of `file` as raw bytes, one byte a pixel.
async function frame(file: string, width: number, height: number): Promise<Buffer> {
  const { stdout } = await ffmpeg(['-i', file, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${width}x${height}`, 'pipe:1']);
  return stdout as unknown as Buffer;
}

function changedShare(a: Buffer, b: Buffer, width: number, region: { x: number; y: number; w: number; h: number }): number {
  let changed = 0;
  for (let y = region.y; y < region.y + region.h; y++) {
    for (let x = region.x; x < region.x + region.w; x++) {
      if (Math.abs(a[y * width + x] - b[y * width + x]) > 24) changed++;
    }
  }
  return changed / (region.w * region.h);
}

const W = 640;
const H = 360;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'dubly-mark-'));
  await ffmpeg(['-f', 'lavfi', '-i', `color=c=white:s=${W}x${H}:r=10`, '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', f('source.mp4')]);
  await ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '2', '-c:a', 'pcm_s16le', f('voice.wav')]);
}, 60_000);

describe('which plans show the label', () => {
  it('shows it on Free and Starter, and not on Enterprise', () => {
    expect(DEFAULT_PLANS.free.visibleWatermark).toBe(true);
    expect(DEFAULT_PLANS.starter.visibleWatermark).toBe(true);
    expect(DEFAULT_PLANS.enterprise.visibleWatermark).toBe(false);
  });

  it('keeps the built-in value for a stored plan from before the field, and takes a stored choice', () => {
    expect(toPlan('starter', { minutesPerMonth: 50 }).visibleWatermark).toBe(true);
    expect(toPlan('enterprise', { minutesPerMonth: 120 }).visibleWatermark).toBe(false);
    expect(toPlan('enterprise', { visibleWatermark: true }).visibleWatermark).toBe(true);
  });
});

describe('a dub with the visible label', () => {
  it('shows it small in the bottom right corner, and nowhere else', async () => {
    const mark = newAiMark(true);
    await muxVideoWithAudio(f('source.mp4'), f('voice.wav'), f('labelled.mp4'), { mark });
    const [before, after] = await Promise.all([frame(f('source.mp4'), W, H), frame(f('labelled.mp4'), W, H)]);

    expect(changedShare(before, after, W, { x: W - 200, y: H - 50, w: 180, h: 35 })).toBeGreaterThan(0.3);
    expect(changedShare(before, after, W, { x: 0, y: 0, w: W, h: H - 60 })).toBe(0);
    expect(changedShare(before, after, W, { x: 0, y: H - 60, w: W / 2, h: 60 })).toBe(0);

    const media = await probeMedia(f('labelled.mp4'));
    expect(media.durationSeconds).toBeGreaterThan(1.5);
    expect((await probeMediaTags(f('labelled.mp4'))).comment).toContain(mark.id);
  }, 60_000);

  it('handles a picture with odd sides', async () => {
    await ffmpeg(['-f', 'lavfi', '-i', 'color=c=white:s=321x241:r=10', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', f('odd.mp4')]);
    await muxVideoWithAudio(f('odd.mp4'), f('voice.wav'), f('odd-labelled.mp4'), { mark: newAiMark(true) });
    expect(await stat(f('odd-labelled.mp4'))).toBeTruthy();
  }, 60_000);

  it('uses an image with a transparent background', async () => {
    const { stdout } = await run(ffmpegPath.replace(/ffmpeg(\.exe)?$/, 'ffmpeg$1'), ['-v', 'error', '-i', AI_LABEL_PATH, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'], {
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
      encoding: 'buffer',
    });
    expect((stdout as unknown as Buffer)[3]).toBe(0);
  });
});

describe('a dub without the visible label', () => {
  it('leaves the picture untouched and still says it is AI-made', async () => {
    const mark = newAiMark(false);
    await muxVideoWithAudio(f('source.mp4'), f('voice.wav'), f('plain.mp4'), { mark });
    const [before, after] = await Promise.all([frame(f('source.mp4'), W, H), frame(f('plain.mp4'), W, H)]);
    expect(before.equals(after)).toBe(true);

    const tags = await probeMediaTags(f('plain.mp4'));
    expect(tags.comment).toMatch(/Dubbed by Dubly Studio/);
    expect(tags.comment).toMatch(/AI-generated/);
    expect(tags.comment).toContain(mark.id);
    expect(tags.description).toContain(mark.id);
  }, 60_000);
});

describe('the mark in the file', () => {
  it('survives the subtitle track and burned captions, and the file still plays', async () => {
    const mark = newAiMark(false);
    await muxVideoWithAudio(f('source.mp4'), f('voice.wav'), f('dub.mp4'), { mark });
    await writeFile(f('captions.srt'), '1\n00:00:00,000 --> 00:00:01,500\nनमस्ते\n', 'utf8');
    await embedSubtitleTrack(f('dub.mp4'), f('captions.srt'), f('dub-cc.mp4'), 'hi');
    expect((await probeMediaTags(f('dub-cc.mp4'))).comment).toContain(mark.id);

    await writeFile(f('captions.ass'), '[Script Info]\nScriptType: v4.00+\n', 'utf8');
    await burnSubtitles(f('dub-cc.mp4'), f('captions.ass'), f('dub-burned.mp4'));
    expect((await probeMediaTags(f('dub-burned.mp4'))).comment).toContain(mark.id);
  }, 120_000);

  it('adds the XMP after everything else, leaving the file playable', async () => {
    const mark = newAiMark(false);
    await muxVideoWithAudio(f('source.mp4'), f('voice.wav'), f('xmp.mp4'), { mark });
    const before = (await stat(f('xmp.mp4'))).size;
    await appendAiXmp(f('xmp.mp4'), mark.id);

    const bytes = await readFile(f('xmp.mp4'));
    const tail = bytes.subarray(before);
    expect(tail.readUInt32BE(0)).toBe(tail.length);
    expect(tail.subarray(4, 8).toString('latin1')).toBe('uuid');
    expect(tail.subarray(8, 24).toString('hex')).toBe('be7acfcb97a942e89c71999491e3afac');
    const xmp = tail.subarray(24).toString('utf8');
    expect(xmp).toContain('compositeWithTrainedAlgorithmicMedia');
    expect(xmp).toContain(`urn:uuid:${mark.id}`);

    expect((await probeMedia(f('xmp.mp4'))).durationSeconds).toBeGreaterThan(1.5);
    await ffmpeg(['-i', f('xmp.mp4'), '-f', 'null', '-']);
  }, 60_000);
});
