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
