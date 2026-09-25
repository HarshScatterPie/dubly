import { afterAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getWavDurationSeconds, openWavSlicer, pcmToWav, sliceWav, speechLevelDb } from './audioUtils';
import { loudnessTarget, measureLoudness, normalizeLoudness, parseLoudnormOutput } from './ffmpeg';

// A mono 16-bit sine at `amplitude` (0..1), with optional silence before it.
function tone(seconds: number, amplitude: number, sampleRate = 16000, leadSilence = 0): Buffer {
  const lead = Math.round(leadSilence * sampleRate);
  const total = lead + Math.round(seconds * sampleRate);
  const pcm = Buffer.alloc(total * 2);
  for (let i = lead; i < total; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude * 32767), i * 2);
  return pcmToWav(pcm, sampleRate);
}

let dir = '';
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('audio helpers', () => {
  it('slices a time range out of a WAV, in memory and from disk', async () => {
    const wav = tone(2, 0.5, 16000, 1);
    expect(getWavDurationSeconds(sliceWav(wav, 0.5, 1.5)!)).toBeCloseTo(1, 2);
    expect(sliceWav(wav, 5, 6)).toBeNull();

    dir = await mkdtemp(path.join(os.tmpdir(), 'dubly-loud-'));
    const file = path.join(dir, 'speech.wav');
    await writeFile(file, wav);
    const slicer = (await openWavSlicer(file))!;
    try {
      const clip = (await slicer.slice(1.25, 1.75))!;
      expect(getWavDurationSeconds(clip)).toBeCloseTo(0.5, 2);
      // The slice sits inside the tone, so it is loud; the lead-in is silence.
      expect(speechLevelDb(clip)!).toBeGreaterThan(-12);
      expect(speechLevelDb((await slicer.slice(0, 0.9))!)).toBeNull();
    } finally {
      await slicer.close();
    }
  });

  it('measures the speech level of a clip, ignoring its silence', () => {
    const loud = speechLevelDb(tone(1, 0.5, 16000, 2))!;
    const quiet = speechLevelDb(tone(1, 0.05))!;
    // A sine's RMS is 3 dB under its peak; the leading silence does not drag it down.
    expect(loud).toBeCloseTo(20 * Math.log10(0.5) - 3, 0);
    expect(loud - quiet).toBeCloseTo(20, 0);
  });
});

describe('loudness matching', () => {
  it('parses loudnorm’s measurement and bounds the target', () => {
    const stderr = 'noise\n[Parsed_loudnorm_0 @ 0x1] \n{\n"input_i" : "-27.61",\n"input_tp" : "-4.47",\n"input_lra" : "18.06",\n"input_thresh" : "-39.20",\n"target_offset" : "0.58"\n}\n';
    expect(parseLoudnormOutput(stderr)).toEqual({ integrated: -27.61, truePeak: -4.47, range: 18.06, threshold: -39.2, offset: 0.58 });
    expect(parseLoudnormOutput('no json here')).toBeNull();
    expect(loudnessTarget(null)).toBe(-16);
    expect(loudnessTarget({ integrated: -30, truePeak: 0, range: 0, threshold: 0, offset: 0 })).toBe(-24);
    expect(loudnessTarget({ integrated: -14, truePeak: 0, range: 0, threshold: 0, offset: 0 })).toBe(-14);
  });

  it('levels a quiet track to the target with real ffmpeg', async () => {
    dir = dir || (await mkdtemp(path.join(os.tmpdir(), 'dubly-loud-')));
    const input = path.join(dir, 'quiet.wav');
    const output = path.join(dir, 'leveled.wav');
    await writeFile(input, tone(8, 0.02, 48000));
    const before = (await measureLoudness(input))!;
    expect(before.integrated).toBeLessThan(-30);
    expect(await normalizeLoudness(input, output, -16)).toBe(true);
    const after = (await measureLoudness(output))!;
    expect(after.integrated).toBeGreaterThan(-17.5);
    expect(after.integrated).toBeLessThan(-14.5);
  }, 60_000);
});
