import { open } from 'node:fs/promises';

/** Wraps raw PCM samples (as returned by Gemini's native TTS) in a canonical 44-byte WAV header. */
export function pcmToWav(pcm: Buffer, sampleRate: number, channels = 1, bitsPerSample = 16): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Reads exact duration from a WAV buffer's header (scans chunks — providers pad differently, so the `data` chunk isn't always at a fixed offset). */
export function getWavDurationSeconds(buffer: Buffer): number {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return 0;
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bitsPerSample = buffer.readUInt16LE(34);

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      const bytesPerSample = (bitsPerSample / 8) * channels;
      return bytesPerSample > 0 ? chunkSize / bytesPerSample / sampleRate : 0;
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return 0;
}

// Locates the fmt/data chunks of a WAV; null for anything that isn't plain 16-bit PCM.
function readPcm16Wav(buffer: Buffer): { sampleRate: number; channels: number; data: Buffer } | null {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF') return null;
  let offset = 12;
  let format: { audioFormat: number; channels: number; sampleRate: number; bits: number } | null = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bits: buffer.readUInt16LE(offset + 22),
      };
    } else if (chunkId === 'data') {
      if (!format || format.audioFormat !== 1 || format.bits !== 16) return null;
      const end = Math.min(buffer.length, offset + 8 + chunkSize);
      return { sampleRate: format.sampleRate, channels: format.channels, data: buffer.subarray(offset + 8, end) };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  return null;
}

const SILENCE_DBFS = -45;
const TRIM_FRAME_SECONDS = 0.01;
// A breath of air is kept on each side so consonant onsets and decays are never clipped.
const KEEP_LEAD_SECONDS = 0.03;
const KEEP_TAIL_SECONDS = 0.08;

// Strips leading/trailing silence from a TTS clip so the voice starts exactly on the segment's start time.
export function trimSilence(wav: Buffer): Buffer {
  const pcm = readPcm16Wav(wav);
  if (!pcm) return wav;
  const { sampleRate, channels, data } = pcm;
  const frameSamples = Math.max(1, Math.round(sampleRate * TRIM_FRAME_SECONDS)) * channels;
  const totalSamples = Math.floor(data.length / 2);
  const threshold = 32768 * Math.pow(10, SILENCE_DBFS / 20);

  const frameIsLoud = (frameStart: number) => {
    let sumSquares = 0;
    const end = Math.min(totalSamples, frameStart + frameSamples);
    for (let i = frameStart; i < end; i++) {
      const s = data.readInt16LE(i * 2);
      sumSquares += s * s;
    }
    return Math.sqrt(sumSquares / Math.max(1, end - frameStart)) > threshold;
  };

  let first = -1;
  for (let f = 0; f < totalSamples; f += frameSamples) {
    if (frameIsLoud(f)) { first = f; break; }
  }
  if (first < 0) return wav;
  let last = first;
  for (let f = Math.floor((totalSamples - 1) / frameSamples) * frameSamples; f >= first; f -= frameSamples) {
    if (frameIsLoud(f)) { last = Math.min(totalSamples, f + frameSamples); break; }
  }

  const align = (n: number) => n - (n % channels);
  const start = align(Math.max(0, first - Math.round(KEEP_LEAD_SECONDS * sampleRate) * channels));
  const end = align(Math.min(totalSamples, last + Math.round(KEEP_TAIL_SECONDS * sampleRate) * channels));
  if (start === 0 && end >= totalSamples) return wav;
  return pcmToWav(Buffer.from(data.subarray(start * 2, end * 2)), sampleRate, channels, 16);
}

// A time range of a 16-bit PCM WAV as its own WAV, cut in memory; null when the buffer is not plain PCM or the range is empty.
export function sliceWav(wav: Buffer, startSeconds: number, endSeconds: number): Buffer | null {
  const pcm = readPcm16Wav(wav);
  if (!pcm) return null;
  const { sampleRate, channels, data } = pcm;
  const frameBytes = 2 * channels;
  const totalFrames = Math.floor(data.length / frameBytes);
  const first = Math.max(0, Math.min(totalFrames, Math.floor(startSeconds * sampleRate)));
  const last = Math.max(first, Math.min(totalFrames, Math.ceil(endSeconds * sampleRate)));
  if (last <= first) return null;
  return pcmToWav(Buffer.from(data.subarray(first * frameBytes, last * frameBytes)), sampleRate, channels, 16);
}

// Loudness of the speech in a clip (RMS of its 10 ms frames above the silence floor, in dBFS); null when nothing rises above it.
export function speechLevelDb(wav: Buffer): number | null {
  const pcm = readPcm16Wav(wav);
  if (!pcm) return null;
  const { sampleRate, channels, data } = pcm;
  const frameSamples = Math.max(1, Math.round(sampleRate * TRIM_FRAME_SECONDS)) * channels;
  const totalSamples = Math.floor(data.length / 2);
  const floor = 32768 * Math.pow(10, SILENCE_DBFS / 20);
  let sumSquares = 0;
  let counted = 0;
  for (let f = 0; f < totalSamples; f += frameSamples) {
    const end = Math.min(totalSamples, f + frameSamples);
    let frameSum = 0;
    for (let i = f; i < end; i++) {
      const s = data.readInt16LE(i * 2);
      frameSum += s * s;
    }
    if (Math.sqrt(frameSum / Math.max(1, end - f)) <= floor) continue;
    sumSquares += frameSum;
    counted += end - f;
  }
  if (counted === 0) return null;
  return 20 * Math.log10(Math.sqrt(sumSquares / counted) / 32768);
}

export interface SpeechBounds {
  /** When the voice audibly starts and stops; null for an edge that could not be told apart from the background. */
  onset: number | null;
  offset: number | null;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))];
}

/**
 * Where the speech in a line really starts and stops, measured on the original's audio.
 *
 * Line timings come from voice-activity detection (padded ~0.1 s either side) or word
 * alignment, so a dub placed on them can start a beat before the speaker's mouth opens —
 * and a voice that arrives *before* the lips is the mismatch viewers notice first. This
 * finds the first and last stretches of sound near the line's edges that are loud relative
 * to the line itself. It only answers when the speech clearly stands above the background
 * (on a vocals stem, or quiet rooms); under music it says nothing rather than guess.
 *
 * `wav` is a clip cut from the original starting at `sliceStart` seconds.
 */
export function detectSpeechBounds(wav: Buffer, sliceStart: number, line: { start: number; end: number }): SpeechBounds | null {
  const pcm = readPcm16Wav(wav);
  if (!pcm) return null;
  const { sampleRate, channels, data } = pcm;
  const frameSamples = Math.max(1, Math.round(sampleRate * TRIM_FRAME_SECONDS)) * channels;
  const totalSamples = Math.floor(data.length / 2);
  const levels: number[] = [];
  for (let f = 0; f + frameSamples <= totalSamples; f += frameSamples) {
    let sum = 0;
    for (let i = f; i < f + frameSamples; i++) {
      const s = data.readInt16LE(i * 2);
      sum += s * s;
    }
    const rms = Math.sqrt(sum / frameSamples) / 32768;
    levels.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  const frameAt = (t: number) => Math.round((t - sliceStart) / TRIM_FRAME_SECONDS);
  const timeOf = (f: number) => sliceStart + f * TRIM_FRAME_SECONDS;
  const inside = levels.slice(Math.max(0, frameAt(line.start)), Math.min(levels.length, frameAt(line.end)));
  if (inside.length < 8) return null;
  const speech = percentile([...inside].sort((a, b) => a - b), 0.9);
  const floor = percentile([...levels].sort((a, b) => a - b), 0.15);
  if (speech < -50 || speech - floor < 14) return null;
  const threshold = Math.max(speech - 24, floor + 9);
  const loud = (f: number) => f >= 0 && f < levels.length && levels[f] >= threshold;
  const runAfter = (f: number) => [0, 1, 2, 3].filter((k) => loud(f + k)).length >= 3;
  const runBefore = (f: number) => [0, 1, 2, 3].filter((k) => loud(f - k)).length >= 3;

  let onset: number | null = null;
  for (let f = Math.max(0, frameAt(line.start - 0.15)); f <= Math.min(levels.length - 1, frameAt(line.start + 0.45)); f++) {
    if (loud(f) && runAfter(f)) {
      onset = timeOf(f);
      break;
    }
  }
  let offset: number | null = null;
  for (let f = Math.min(levels.length - 1, frameAt(line.end + 0.2)); f >= Math.max(0, frameAt(line.end - 0.45)); f--) {
    if (loud(f) && runBefore(f)) {
      offset = timeOf(f + 1);
      break;
    }
  }
  if (onset !== null && offset !== null && offset - onset < 0.15) return null;
  return { onset, offset };
}

export interface WavSlicer {
  slice: (startSeconds: number, endSeconds: number) => Promise<Buffer | null>;
  close: () => Promise<void>;
}

// Cuts line-length clips out of a long 16-bit PCM WAV on disk without loading it (a 60-minute 16 kHz track is ~115 MB).
export async function openWavSlicer(filePath: string): Promise<WavSlicer | null> {
  const handle = await open(filePath, 'r');
  try {
    const head = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(head, 0, head.length, 0);
    const size = (await handle.stat()).size;
    if (bytesRead < 44 || head.toString('ascii', 0, 4) !== 'RIFF') throw new Error('not a WAV');
    let offset = 12;
    let format: { channels: number; sampleRate: number; bits: number; audioFormat: number } | null = null;
    let dataStart = -1;
    let dataBytes = 0;
    while (offset + 8 <= bytesRead) {
      const chunkId = head.toString('ascii', offset, offset + 4);
      const chunkSize = head.readUInt32LE(offset + 4);
      if (chunkId === 'fmt ') {
        format = { audioFormat: head.readUInt16LE(offset + 8), channels: head.readUInt16LE(offset + 10), sampleRate: head.readUInt32LE(offset + 12), bits: head.readUInt16LE(offset + 22) };
      } else if (chunkId === 'data') {
        dataStart = offset + 8;
        // A streamed WAV may carry a placeholder size, so the file's real length wins.
        dataBytes = Math.min(chunkSize, size - dataStart);
        break;
      }
      offset += 8 + chunkSize + (chunkSize % 2);
    }
    if (!format || format.audioFormat !== 1 || format.bits !== 16 || dataStart < 0) throw new Error('not 16-bit PCM');
    const { channels, sampleRate } = format;
    const frameBytes = 2 * channels;
    const totalFrames = Math.floor(dataBytes / frameBytes);
    return {
      slice: async (startSeconds, endSeconds) => {
        const first = Math.max(0, Math.min(totalFrames, Math.floor(startSeconds * sampleRate)));
        const last = Math.max(first, Math.min(totalFrames, Math.ceil(endSeconds * sampleRate)));
        if (last <= first) return null;
        const pcm = Buffer.alloc((last - first) * frameBytes);
        await handle.read(pcm, 0, pcm.length, dataStart + first * frameBytes);
        return pcmToWav(pcm, sampleRate, channels, 16);
      },
      close: () => handle.close(),
    };
  } catch {
    await handle.close();
    return null;
  }
}

// A mono 16-bit WAV of silence, for a line whose engine has no words to say.
export function silenceWav(seconds: number, sampleRate: number): Buffer {
  return pcmToWav(Buffer.alloc(Math.round(seconds * sampleRate) * 2), sampleRate);
}
