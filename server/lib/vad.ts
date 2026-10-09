import * as ort from 'onnxruntime-node';
import { ffmpeg } from './mediaTools';
import { existsSync } from 'node:fs';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { createCpuSession } from './onnxSession';
import { runOffThread } from './onnxPool';
import { serverRoot, tmpDir } from './paths';

/**
 * Real voice-activity detection using Silero VAD (ONNX, CPU, ~2MB, runs locally).
 *
 * This replaces amplitude-based silence detection, which cannot tell speech apart from
 * any other loud sound. That distinction is not academic: on a TED-style clip the opening
 * applause is far above any sensible noise floor, so `silencedetect` reported speech
 * starting at 0.00s when the speaker actually begins at ~8s — dragging the whole
 * transcript, captions and dubbed audio out of sync from the very first segment. Silero is
 * trained specifically to detect human speech, so applause, music and room noise are
 * correctly excluded.
 */

const MODEL_PATH = path.join(serverRoot, 'models', 'silero_vad.onnx');
const SAMPLE_RATE = 16000;
// Silero v5 advances in fixed 512-sample steps at 16kHz (32ms of audio per step), but the
// tensor it expects is the previous 64 samples of context followed by those 512 new
// samples. Feeding the bare 512 samples "works" in that the model runs without error, yet
// it then reports near-zero speech probability for even loud, clean speech (measured: max
// 0.0497 across a 7.5s utterance vs 1.0 once context is included), so the context is not
// optional.
const WINDOW_SAMPLES = 512;
const CONTEXT_SAMPLES = 64;
const WINDOW_SECONDS = WINDOW_SAMPLES / SAMPLE_RATE;

// Standard Silero post-processing thresholds. Two thresholds (rather than one) give
// hysteresis, so a brief dip in confidence mid-word doesn't chop a region in half.
const SPEECH_THRESHOLD = 0.5;
const SILENCE_THRESHOLD = 0.35;
const MIN_SPEECH_SECONDS = 0.25;
const MIN_SILENCE_SECONDS = 0.35;
const SPEECH_PAD_SECONDS = 0.12;

export interface SpeechRegion {
  start: number;
  end: number;
}

export function isVadAvailable(): boolean {
  return existsSync(MODEL_PATH);
}

let sessionPromise: Promise<ort.InferenceSession> | null = null;
function getSession(): Promise<ort.InferenceSession> {
  if (!sessionPromise) {
    sessionPromise = createCpuSession(MODEL_PATH);
  }
  return sessionPromise;
}

/** Decodes any audio file to a raw mono 16kHz s16le file via ffmpeg, sidestepping WAV-header edge cases; the caller removes the file. */
async function decodeToRaw(audioPath: string): Promise<string> {
  await mkdir(tmpDir, { recursive: true });
  const rawPath = path.join(tmpDir, `vad_${randomUUID()}.raw`);
  try {
    await new Promise<void>((resolve, reject) => {
      ffmpeg({ timeout: 10 * 60 })
        .input(audioPath)
        .inputOptions(['-protocol_whitelist', 'file'])
        .audioCodec('pcm_s16le')
        .audioFrequency(SAMPLE_RATE)
        .audioChannels(1)
        .outputFormat('s16le')
        .on('error', reject)
        .on('end', () => resolve())
        .save(rawPath);
    });
    return rawPath;
  } catch (err) {
    await rm(rawPath, { force: true }).catch(() => undefined);
    throw err;
  }
}

// Windows read from disk per batch (about 1 MiB), so a long recording is never held in memory whole.
const BATCH_WINDOWS = 1024;

/**
 * Speech probability of every 32 ms window of a raw s16le file. Buffers, tensors and the hidden state are allocated once and
 * reused for the whole file: a one-hour recording is over 100,000 windows, and allocating several arrays per window dominated the run.
 */
export async function speechProbabilities(rawPath: string): Promise<Float32Array> {
  const session = await getSession();
  const windows = Math.floor((await stat(rawPath)).size / 2 / WINDOW_SAMPLES);
  const probs = new Float32Array(windows);

  // Silero is a stateful (RNN) model — the hidden state carries across windows, which is
  // what lets it use context rather than judging each 32ms slice in isolation.
  const state = new Float32Array(2 * 1 * 128);
  const stateTensor = new ort.Tensor('float32', state, [2, 1, 128]);
  const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);
  // The model input is the previous window's last CONTEXT_SAMPLES samples followed by the next WINDOW_SAMPLES (silence before the first).
  const input = new Float32Array(CONTEXT_SAMPLES + WINDOW_SAMPLES);
  const inputTensor = new ort.Tensor('float32', input, [1, input.length]);

  const bytes = new ArrayBuffer(BATCH_WINDOWS * WINDOW_SAMPLES * 2);
  const raw = Buffer.from(bytes);
  // s16le is the host's own byte order on every platform this runs on (x86-64 and arm64).
  const samples = new Int16Array(bytes);
  const file = await open(rawPath, 'r');
  try {
    for (let done = 0; done < windows; ) {
      const batch = Math.min(BATCH_WINDOWS, windows - done);
      const want = batch * WINDOW_SAMPLES * 2;
      let got = 0;
      while (got < want) {
        const { bytesRead } = await file.read(raw, got, want - got, done * WINDOW_SAMPLES * 2 + got);
        if (bytesRead === 0) break;
        got += bytesRead;
      }
      const have = Math.floor(got / (WINDOW_SAMPLES * 2));
      for (let w = 0; w < have; w++) {
        input.copyWithin(0, WINDOW_SAMPLES, WINDOW_SAMPLES + CONTEXT_SAMPLES);
        const from = w * WINDOW_SAMPLES;
        for (let k = 0; k < WINDOW_SAMPLES; k++) input[CONTEXT_SAMPLES + k] = samples[from + k] / 32768;
        const results = await session.run({ input: inputTensor, state: stateTensor, sr: srTensor });
        probs[done + w] = (results.output.data as Float32Array)[0];
        state.set(results.stateN.data as Float32Array);
      }
      if (have < batch) return probs.subarray(0, done + have);
      done += batch;
    }
  } finally {
    await file.close();
  }
  return probs;
}

/** The detection itself, in whichever thread calls it; the worker thread's entry point (onnxWorker.ts). */
export async function detectSpeechRegionsVadLocal(audioPath: string, totalDuration: number): Promise<SpeechRegion[]> {
  const rawPath = await decodeToRaw(audioPath);
  try {
    return regionsFromProbabilities(await speechProbabilities(rawPath), totalDuration);
  } finally {
    await rm(rawPath, { force: true }).catch(() => undefined);
  }
}

// Runs in a worker thread: Silero makes one blocking ONNX call per 32 ms window, which would otherwise hold up the whole API.
export function detectSpeechRegionsVad(audioPath: string, totalDuration: number): Promise<SpeechRegion[]> {
  return runOffThread('vad', { audioPath, totalDuration }, () => detectSpeechRegionsVadLocal(audioPath, totalDuration));
}

/** Turns per-window probabilities into padded speech regions (two thresholds for hysteresis, minimum lengths, no overlap). */
export function regionsFromProbabilities(probs: ArrayLike<number>, totalDuration: number): SpeechRegion[] {
  const regions: SpeechRegion[] = [];
  let triggered = false;
  let currentStart = 0;
  let provisionalEnd = 0;

  for (let i = 0; i < probs.length; i++) {
    const t = i * WINDOW_SECONDS;
    const p = probs[i];

    if (p >= SPEECH_THRESHOLD) {
      provisionalEnd = 0;
      if (!triggered) {
        triggered = true;
        currentStart = t;
      }
      continue;
    }

    if (triggered && p < SILENCE_THRESHOLD) {
      if (!provisionalEnd) provisionalEnd = t;
      // Only close the region once the quiet stretch is long enough to be a real pause.
      if (t - provisionalEnd >= MIN_SILENCE_SECONDS) {
        if (provisionalEnd - currentStart >= MIN_SPEECH_SECONDS) {
          regions.push({ start: currentStart, end: provisionalEnd });
        }
        triggered = false;
        provisionalEnd = 0;
      }
    }
  }
  if (triggered && totalDuration - currentStart >= MIN_SPEECH_SECONDS) {
    regions.push({ start: currentStart, end: totalDuration });
  }

  // Pad slightly to recover soft onsets/decays, without letting neighbours overlap.
  return regions.map((r, i) => {
    const prevEnd = i > 0 ? regions[i - 1].end : 0;
    const nextStart = i < regions.length - 1 ? regions[i + 1].start : totalDuration;
    return {
      start: Math.max(prevEnd, Math.max(0, r.start - SPEECH_PAD_SECONDS)),
      end: Math.min(nextStart, Math.min(totalDuration, r.end + SPEECH_PAD_SECONDS)),
    };
  });
}
