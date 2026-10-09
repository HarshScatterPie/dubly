import { describe, expect, it } from 'vitest';
import * as ort from 'onnxruntime-node';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { toInput } from './faceScan';
import { regionsFromProbabilities, speechProbabilities } from './vad';
import { runOffThread } from './onnxPool';
import { ffmpegPath } from './mediaTools';
import { repoRoot, serverRoot } from './paths';

const run = promisify(execFile);

// The preprocessing and voice-activity loops were rewritten for speed; these keep the originals as the reference they must match.
function referenceToInput(frame: { width: number; height: number; rgb: Uint8Array }): { data: Float32Array; scale: number } {
  const INPUT_SIZE = 640;
  const { width, height, rgb } = frame;
  let newW: number;
  let newH: number;
  if (height / width > 1) {
    newH = INPUT_SIZE;
    newW = Math.trunc(newH / (height / width));
  } else {
    newW = INPUT_SIZE;
    newH = Math.trunc(newW * (height / width));
  }
  const plane = INPUT_SIZE * INPUT_SIZE;
  const data = new Float32Array(3 * plane).fill(-127.5 / 128);
  const sx = width / newW;
  const sy = height / newH;
  for (let y = 0; y < newH; y++) {
    const fy = Math.min(height - 1, Math.max(0, (y + 0.5) * sy - 0.5));
    const y0 = Math.floor(fy);
    const y1 = Math.min(height - 1, y0 + 1);
    const wy = fy - y0;
    for (let x = 0; x < newW; x++) {
      const fx = Math.min(width - 1, Math.max(0, (x + 0.5) * sx - 0.5));
      const x0 = Math.floor(fx);
      const x1 = Math.min(width - 1, x0 + 1);
      const wx = fx - x0;
      for (let c = 0; c < 3; c++) {
        const top = rgb[(y0 * width + x0) * 3 + c] * (1 - wx) + rgb[(y0 * width + x1) * 3 + c] * wx;
        const bottom = rgb[(y1 * width + x0) * 3 + c] * (1 - wx) + rgb[(y1 * width + x1) * 3 + c] * wx;
        data[c * plane + y * INPUT_SIZE + x] = (Math.round(top * (1 - wy) + bottom * wy) - 127.5) / 128;
      }
    }
  }
  return { data, scale: newH / height };
}

function noisyFrame(width: number, height: number, seed: number) {
  const rgb = new Uint8Array(width * height * 3);
  let s = seed;
  for (let i = 0; i < rgb.length; i++) {
    s = (s * 1664525 + 1013904223) >>> 0;
    rgb[i] = s >>> 24;
  }
  return { width, height, rgb };
}

describe('face detector input', () => {
  it.each([
    ['landscape', 640, 480],
    ['portrait', 360, 640],
    ['square', 500, 500],
    ['smaller than the input', 97, 53],
    ['full HD', 1920, 1080],
  ])('is identical to the straightforward version for a %s frame', (_name, width, height) => {
    const frame = noisyFrame(width, height, width * 31 + height);
    const fast = toInput(frame);
    const reference = referenceToInput(frame);
    expect(fast.scale).toBe(reference.scale);
    expect(fast.tensor.dims).toEqual([1, 3, 640, 640]);
    // Same arithmetic in the same order, so equal bit for bit.
    expect(Buffer.from((fast.tensor.data as Float32Array).buffer).equals(Buffer.from(reference.data.buffer))).toBe(true);
  });
});

describe('voice activity detection', () => {
  const SAMPLE_RATE = 16000;
  const WINDOW = 512;
  const CONTEXT = 64;

  // Syllable-like bursts of a voiced tone over a little noise, as raw s16le.
  function syntheticSpeech(seconds: number): Buffer {
    const count = seconds * SAMPLE_RATE;
    const pcm = Buffer.alloc(count * 2);
    let s = 7;
    for (let i = 0; i < count; i++) {
      s = (s * 1664525 + 1013904223) >>> 0;
      const t = i / SAMPLE_RATE;
      const envelope = Math.max(0, Math.sin(2 * Math.PI * 2.5 * t));
      const voiced = [1, 2, 3, 4].reduce((sum, h) => sum + Math.sin(2 * Math.PI * 130 * h * t) / h, 0);
      const noise = ((s >>> 16) / 65536 - 0.5) * 0.05;
      pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, envelope * 0.4 * voiced + noise)) * 32767), i * 2);
    }
    return pcm;
  }

  // The loop as it was before: a fresh array per window, state copied each step.
  async function referenceProbabilities(pcmBytes: Buffer): Promise<number[]> {
    const session = await ort.InferenceSession.create(path.join(serverRoot, 'models', 'silero_vad.onnx'));
    const count = Math.floor(pcmBytes.length / 2);
    const pcm = new Float32Array(count);
    for (let i = 0; i < count; i++) pcm[i] = pcmBytes.readInt16LE(i * 2) / 32768;
    let state = new Float32Array(2 * 1 * 128);
    const sr = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);
    let context = new Float32Array(CONTEXT);
    const probs: number[] = [];
    for (let i = 0; i + WINDOW <= pcm.length; i += WINDOW) {
      const chunk = pcm.slice(i, i + WINDOW);
      const input = new Float32Array(CONTEXT + WINDOW);
      input.set(context, 0);
      input.set(chunk, CONTEXT);
      context = chunk.slice(WINDOW - CONTEXT);
      const results = await session.run({
        input: new ort.Tensor('float32', input, [1, input.length]),
        state: new ort.Tensor('float32', state, [2, 1, 128]),
        sr,
      });
      probs.push(Number((results.output.data as Float32Array)[0]));
      state = Float32Array.from(results.stateN.data as Float32Array);
    }
    return probs;
  }

  it('gives the same probabilities as the original per-window loop', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dubly-vad-'));
    try {
      // 20 s is more than one disk batch of windows, so the batch boundary is crossed too.
      const bytes = syntheticSpeech(20);
      const rawPath = path.join(dir, 'speech.raw');
      await writeFile(rawPath, bytes);
      const fast = await speechProbabilities(rawPath);
      const reference = await referenceProbabilities(bytes);
      expect(fast.length).toBe(reference.length);
      expect(reference.some((p) => p > 0.5)).toBe(true);
      for (let i = 0; i < reference.length; i++) expect(Math.abs(fast[i] - reference[i])).toBeLessThan(1e-5);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('ignores a trailing partial window, like the original', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dubly-vad-'));
    try {
      const rawPath = path.join(dir, 'short.raw');
      await writeFile(rawPath, Buffer.concat([syntheticSpeech(1), Buffer.alloc(300 * 2)]));
      expect((await speechProbabilities(rawPath)).length).toBe(Math.floor(SAMPLE_RATE / WINDOW));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('turns probabilities into padded speech regions', () => {
    const windowSeconds = WINDOW / SAMPLE_RATE;
    const probs = [...Array(30).fill(0.9), ...Array(60).fill(0.05), ...Array(30).fill(0.9)];
    const regions = regionsFromProbabilities(probs, probs.length * windowSeconds);
    expect(regions).toHaveLength(2);
    expect(regions[0].start).toBe(0);
    expect(regions[0].end).toBeGreaterThan(30 * windowSeconds);
    expect(regions[1].start).toBeLessThan(90 * windowSeconds);
    expect(regions[1].end).toBeCloseTo(probs.length * windowSeconds, 5);
  });
});

describe('running inference off the main thread', () => {
  it('runs the in-process version when workers are off (as in tests)', async () => {
    expect(await runOffThread('vad', {}, async () => 'ran here')).toBe('ran here');
  });

  // A worker that cannot start would fall back to the main thread without a word, so this proves a real one starts and answers.
  it('starts a worker thread under the server loader and gets an answer from it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dubly-worker-'));
    try {
      const wav = path.join(dir, 'noise.wav');
      await run(ffmpegPath, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'anoisesrc=d=2:sample_rate=16000', '-ac', '1', wav]);
      const script = `
        import { runOffThread } from ${JSON.stringify(pathToFileURL(path.join(serverRoot, 'lib', 'onnxPool.ts')).href)};
        const regions = await runOffThread('vad', { audioPath: ${JSON.stringify(wav)}, totalDuration: 2 }, () => Promise.reject(new Error('ran in-process')));
        console.log('REGIONS=' + JSON.stringify(regions));
        process.exit(0);
      `;
      const { stdout } = await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
        cwd: repoRoot,
        env: { ...process.env, VITEST: '', ONNX_WORKERS: '1' },
        timeout: 60_000,
      });
      expect(stdout).toMatch(/REGIONS=\[/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 90_000);
});
