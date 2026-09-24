import * as ort from 'onnxruntime-node';
import { ffmpeg } from './mediaTools';
import { existsSync } from 'node:fs';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
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
    sessionPromise = ort.InferenceSession.create(MODEL_PATH);
  }
  return sessionPromise;
}

/** Decodes any audio file to raw mono 16kHz float samples via ffmpeg, sidestepping WAV-header edge cases. */
async function decodeToPcm(audioPath: string): Promise<Float32Array> {
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
    const buf = await readFile(rawPath);
    const count = Math.floor(buf.length / 2);
    const pcm = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      pcm[i] = buf.readInt16LE(i * 2) / 32768;
    }
    return pcm;
  } finally {
    await rm(rawPath, { force: true }).catch(() => undefined);
  }
}

export async function detectSpeechRegionsVad(audioPath: string, totalDuration: number): Promise<SpeechRegion[]> {
  const session = await getSession();
  const pcm = await decodeToPcm(audioPath);

  // Silero is a stateful (RNN) model — the hidden state carries across windows, which is
  // what lets it use context rather than judging each 32ms slice in isolation.
  let state = new Float32Array(2 * 1 * 128);
  const srTensor = new ort.Tensor('int64', BigInt64Array.from([BigInt(SAMPLE_RATE)]), [1]);

  let context = new Float32Array(CONTEXT_SAMPLES);
  const probs: number[] = [];
  for (let i = 0; i + WINDOW_SAMPLES <= pcm.length; i += WINDOW_SAMPLES) {
    const chunk = pcm.slice(i, i + WINDOW_SAMPLES);
    const input = new Float32Array(CONTEXT_SAMPLES + WINDOW_SAMPLES);
    input.set(context, 0);
    input.set(chunk, CONTEXT_SAMPLES);
    context = chunk.slice(WINDOW_SAMPLES - CONTEXT_SAMPLES);

    const results = await session.run({
      input: new ort.Tensor('float32', input, [1, input.length]),
      state: new ort.Tensor('float32', state, [2, 1, 128]),
      sr: srTensor,
    });
    probs.push(Number((results.output.data as Float32Array)[0]));
    state = Float32Array.from(results.stateN.data as Float32Array);
  }

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
