import { spawn } from 'node:child_process';
import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { getWavDurationSeconds } from './audioUtils';
import { buildAtempoChain, MAX_COMPRESSION, runFfmpeg, SAFE_INPUT_OPTIONS, SEGMENT_GUARD_SECONDS, TIMEOUT } from './ffmpeg';
import { ffmpegPath } from './mediaTools';

/**
 * Builds a dub's soundtrack in two passes:
 *
 *  1. The voice track. Every line is shaped (tempo, pitch) on its own and written into one
 *     WAV at the exact sample it starts on, with short fades so no line starts or stops on
 *     a click. This used to be one ffmpeg graph with an input, a delay and a full-length
 *     pad per line — hundreds of full-length streams for a long video — and placement was
 *     only as exact as `adelay`'s millisecond. The voice track on its own is also what
 *     lip-sync listens to, so the mouth follows the voice and not the music under it.
 *  2. The mix. The voice sits in the centre of a stereo mix over the background bed, which
 *     is ducked by a smooth gain envelope instead of being switched on and off.
 */

export const VOICE_SAMPLE_RATE = 48000;
/** trimSilence keeps this much air before a take's first sound; placing a take this early puts its first sound on the mark. */
export const TAKE_LEAD_SECONDS = 0.03;
/** In lip-sync mode a line may run this far past the mouth before it is sped up to fit. */
const STRICT_OVERRUN = 1.06;
/** How much faster (or slower) than the user's pace a line may be shaped to follow the mouth; small enough to stay natural. */
export const STRICT_MAX_TEMPO = 1.22;
const STRICT_MIN_TEMPO = 0.92;

export interface TimedAudioSegment {
  startTime: number;
  endTime: number;
  audio: Buffer;
  // Level change for this line so it keeps the original's dynamics (levelMatch.ts); 0 or absent leaves it as synthesized.
  gainDb?: number;
}

export interface LineTiming {
  /** When the original speaker's mouth starts and stops on this line. */
  start: number;
  end: number;
  /** The take's length at its natural pace. */
  rawSeconds: number;
}

export interface Placement {
  /** Where the take is placed (its first sound lands TAKE_LEAD_SECONDS later). */
  start: number;
  tempo: number;
  playedSeconds: number;
}

/**
 * Decides where and how fast each line plays.
 *
 * Every line starts where the original speaker starts. Its pace is the user's chosen speed,
 * except that a line which would run into the next one is compressed (never past
 * MAX_COMPRESSION). In `strict` mode — a face is on screen, or lip-sync is on — the line is
 * also fitted to the mouth: a take that would keep talking after the speaker's mouth closes
 * is sped up a little, and one that would finish well before is slowed a little, both within
 * a range that still sounds like natural speech.
 */
export function planPlacements(lines: LineTiming[], opts: { totalSeconds: number; speed: number; strict: boolean }): Placement[] {
  const speed = Math.min(1.5, Math.max(0.6, opts.speed || 1));
  const order = lines.map((_, i) => i).sort((a, b) => lines[a].start - lines[b].start);
  const placements: Placement[] = new Array(lines.length);
  order.forEach((index, k) => {
    const line = lines[index];
    const start = Math.max(0, line.start);
    const nextStart = k + 1 < order.length ? lines[order[k + 1]].start : opts.totalSeconds;
    const slot = Math.max(0.2, line.end - start);
    const available = Math.max(slot, nextStart - start - SEGMENT_GUARD_SECONDS);
    const raw = line.rawSeconds > 0 ? line.rawSeconds : slot * speed;
    let tempo = speed;
    if (opts.strict) {
      const natural = raw / speed;
      if (natural > slot * STRICT_OVERRUN) tempo = Math.min(raw / (slot * STRICT_OVERRUN), speed * STRICT_MAX_TEMPO);
      else if (natural < slot * 0.8) tempo = Math.max(raw / (slot * 0.9), speed * STRICT_MIN_TEMPO);
    }
    if (raw / tempo > available) tempo = Math.min(raw / available, speed * MAX_COMPRESSION);
    tempo = Math.max(0.5, tempo);
    placements[index] = { start, tempo, playedSeconds: raw / tempo };
  });
  return placements;
}

let filterList: Promise<string> | null = null;
// The filters this ffmpeg build has: Rubber Band (pitch without the chipmunk formant shift of resampling) is not in every build.
function ffmpegFilters(): Promise<string> {
  filterList ??= new Promise((resolve) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-filters'], { windowsHide: true });
    let out = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.on('error', () => resolve(''));
    proc.on('close', () => resolve(out));
  });
  return filterList;
}

async function shapeFilter(tempo: number, pitch: number): Promise<string> {
  const parts = ['aformat=channel_layouts=mono', `aresample=${VOICE_SAMPLE_RATE}`];
  const shiftsPitch = Math.abs(pitch - 1) > 0.005;
  if (shiftsPitch && /\brubberband\b/.test(await ffmpegFilters())) {
    parts.push(`rubberband=tempo=${tempo.toFixed(4)}:pitch=${pitch.toFixed(4)}:formant=preserved:pitchq=quality`);
  } else if (shiftsPitch) {
    // Resampling raises the pitch and the pace together; the tempo change undoes the pace.
    parts.push(`asetrate=${Math.round(VOICE_SAMPLE_RATE * pitch)}`, `aresample=${VOICE_SAMPLE_RATE}`, buildAtempoChain(tempo / pitch));
  } else if (Math.abs(tempo - 1) > 0.003) {
    parts.push(buildAtempoChain(tempo));
  }
  return parts.join(',');
}

/** One take, shaped and resampled to the voice track's rate, as float samples. */
async function shapeTake(audio: Buffer, tempo: number, pitch: number): Promise<Float32Array> {
  const filter = await shapeFilter(tempo, pitch);
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ['-hide_banner', '-loglevel', 'error', ...SAFE_INPUT_OPTIONS, '-f', 'wav', '-i', 'pipe:0', '-af', filter, '-f', 'f32le', '-ac', '1', '-ar', String(VOICE_SAMPLE_RATE), 'pipe:1'],
      { windowsHide: true }
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => proc.kill(), 120_000);
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on('data', (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-600)));
    proc.stdin.on('error', () => undefined);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`shaping a take failed: ${stderr}`));
      const bytes = Buffer.concat(chunks);
      const samples = new Float32Array(Math.floor(bytes.length / 4));
      for (let i = 0; i < samples.length; i++) samples[i] = bytes.readFloatLE(i * 4);
      resolve(samples);
    });
    proc.stdin.end(audio);
  });
}

// Raised-cosine ramps: 4 ms in (a hard onset is a click), 12 ms out (a cut tail is a click too).
function applyFades(samples: Float32Array, gain: number): void {
  const fadeIn = Math.min(samples.length >> 1, Math.round(0.004 * VOICE_SAMPLE_RATE));
  const fadeOut = Math.min(samples.length >> 1, Math.round(0.012 * VOICE_SAMPLE_RATE));
  for (let i = 0; i < samples.length; i++) {
    let g = gain;
    if (i < fadeIn) g *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
    const fromEnd = samples.length - 1 - i;
    if (fromEnd < fadeOut) g *= 0.5 - 0.5 * Math.cos((Math.PI * fromEnd) / fadeOut);
    samples[i] *= g;
  }
}

function wavHeader(totalSamples: number, sampleRate: number, channels = 1): Buffer {
  const dataBytes = totalSamples * 2 * channels;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2 * channels, 28);
  header.writeUInt16LE(2 * channels, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Writes a mono 16-bit WAV of fixed length from clips added in start order. Only the span
 * clips can still reach is held in memory, so an hour-long track never sits in RAM whole.
 */
class TrackWriter {
  private pending = new Float32Array(0);
  private written = 0;
  private constructor(
    private readonly handle: Awaited<ReturnType<typeof open>>,
    private readonly total: number
  ) {}

  static async create(filePath: string, totalSamples: number, sampleRate: number): Promise<TrackWriter> {
    const handle = await open(filePath, 'w');
    await handle.write(wavHeader(totalSamples, sampleRate));
    return new TrackWriter(handle, totalSamples);
  }

  async add(at: number, samples: Float32Array): Promise<void> {
    const start = Math.max(this.written, Math.min(at, this.total));
    await this.flushTo(start);
    const end = Math.min(this.total, start + samples.length);
    const needed = end - this.written;
    if (needed > this.pending.length) {
      const grown = new Float32Array(needed);
      grown.set(this.pending);
      this.pending = grown;
    }
    const offset = start - this.written;
    for (let i = 0; i < end - start; i++) this.pending[offset + i] += samples[i];
  }

  private async flushTo(sample: number): Promise<void> {
    const CHUNK = 1 << 20;
    while (this.written < sample) {
      const n = Math.min(CHUNK, sample - this.written);
      const out = Buffer.alloc(n * 2);
      const held = Math.min(n, this.pending.length);
      for (let i = 0; i < held; i++) {
        const v = Math.max(-1, Math.min(1, this.pending[i]));
        out.writeInt16LE(Math.round(v * 32767), i * 2);
      }
      await this.handle.write(out);
      this.written += n;
      this.pending = held < this.pending.length ? this.pending.slice(held) : new Float32Array(0);
    }
  }

  async finish(): Promise<void> {
    await this.flushTo(this.total);
    await this.handle.close();
  }

  async abort(): Promise<void> {
    await this.handle.close().catch(() => undefined);
  }
}

export interface VoiceClip {
  audio: Buffer;
  start: number;
  tempo: number;
  gainDb?: number;
}

/** Renders the voice-only track: every take at its place, pace and level, as one mono WAV exactly `totalSeconds` long. */
export async function renderVoiceTrack(clips: VoiceClip[], opts: { totalSeconds: number; pitch: number; outputPath: string }): Promise<void> {
  const pitch = Math.min(1.3, Math.max(0.7, opts.pitch || 1));
  const totalSamples = Math.max(1, Math.round(Math.max(1, opts.totalSeconds) * VOICE_SAMPLE_RATE));
  const ordered = [...clips].sort((a, b) => a.start - b.start);
  const writer = await TrackWriter.create(opts.outputPath, totalSamples, VOICE_SAMPLE_RATE);
  try {
    // Shaped a few at a time (each is its own short ffmpeg run), added strictly in order.
    const BATCH = 4;
    for (let i = 0; i < ordered.length; i += BATCH) {
      const group = ordered.slice(i, i + BATCH);
      const shaped = await Promise.all(group.map((clip) => shapeTake(clip.audio, clip.tempo, pitch)));
      for (let k = 0; k < group.length; k++) {
        applyFades(shaped[k], Math.pow(10, (group[k].gainDb ?? 0) / 20));
        await writer.add(Math.round(group[k].start * VOICE_SAMPLE_RATE), shaped[k]);
      }
    }
    await writer.finish();
  } catch (err) {
    await writer.abort();
    throw err;
  }
}

export interface DuckSpan {
  start: number;
  end: number;
  /** Gain the bed drops to (0 mutes it). */
  level: number;
  /** Seconds the bed takes to fade down before `start` and back up after `end`. */
  attack: number;
  release: number;
}

const ENVELOPE_RATE = 1000;

/** The bed's gain over time as a 1 kHz WAV; ffmpeg multiplies the bed by it. The quietest span wins where spans overlap. */
async function writeEnvelope(filePath: string, totalSeconds: number, spans: DuckSpan[]): Promise<void> {
  const n = Math.ceil(totalSeconds * ENVELOPE_RATE) + 2;
  const gain = new Float32Array(n).fill(1);
  for (const span of spans) {
    const level = Math.max(0, Math.min(1, span.level));
    const from = Math.max(0, Math.floor((span.start - span.attack) * ENVELOPE_RATE));
    const to = Math.min(n - 1, Math.ceil((span.end + span.release) * ENVELOPE_RATE));
    for (let i = from; i <= to; i++) {
      const t = i / ENVELOPE_RATE;
      let g: number;
      if (t < span.start) g = span.attack > 0 ? 1 - (1 - level) * ((t - (span.start - span.attack)) / span.attack) : level;
      else if (t <= span.end) g = level;
      else g = span.release > 0 ? level + (1 - level) * ((t - span.end) / span.release) : 1;
      g = Math.max(level, Math.min(1, g));
      if (g < gain[i]) gain[i] = g;
    }
  }
  const handle = await open(filePath, 'w');
  try {
    const body = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) body.writeInt16LE(Math.round(gain[i] * 32767), i * 2);
    await handle.write(Buffer.concat([wavHeader(n, ENVELOPE_RATE), body]));
  } finally {
    await handle.close();
  }
}

/**
 * Mixes the voice track over the background bed into a 48 kHz stereo WAV `totalSeconds` long.
 * The voice sits in the centre at `voiceGainDb`; the bed is shaped by `spans` (fully muted
 * where the original speaker would otherwise be heard, gently lowered under the dub).
 */
export async function mixDubAudio(params: {
  voicePath: string;
  totalSeconds: number;
  outputPath: string;
  workDir: string;
  voiceGainDb?: number;
  bed?: { path: string; spans: DuckSpan[] };
}): Promise<string> {
  const { voicePath, outputPath, workDir, bed } = params;
  const total = Math.max(1, params.totalSeconds).toFixed(3);
  const gain = Math.max(-18, Math.min(18, params.voiceGainDb ?? 0)).toFixed(2);
  // A touch of low cut takes the rumble and DC some voices carry; the voice goes to both channels at full level.
  const voice = `[0:a]aformat=sample_fmts=fltp:sample_rates=${VOICE_SAMPLE_RATE}:channel_layouts=mono,highpass=f=70,volume=${gain}dB,pan=stereo|c0=c0|c1=c0,apad,atrim=end=${total}[voice]`;
  const inputs = [...SAFE_INPUT_OPTIONS, '-i', voicePath];
  let graph: string;
  if (bed) {
    const envelopePath = path.join(workDir, 'bed_envelope.wav');
    await writeEnvelope(envelopePath, params.totalSeconds, bed.spans);
    inputs.push(...SAFE_INPUT_OPTIONS, '-i', bed.path, ...SAFE_INPUT_OPTIONS, '-i', envelopePath);
    const stereo = `aresample=${VOICE_SAMPLE_RATE},aformat=sample_fmts=fltp:sample_rates=${VOICE_SAMPLE_RATE}:channel_layouts=stereo,apad,atrim=end=${total}`;
    graph = [
      voice,
      `[1:a]${stereo}[bedraw]`,
      `[2:a]${stereo}[envelope]`,
      '[bedraw][envelope]amultiply[bed]',
      // Both inputs run the full length, so amix's 1/2 scaling is constant and `volume=2` undoes it exactly.
      '[bed][voice]amix=inputs=2:duration=first:dropout_transition=0,volume=2,alimiter=limit=0.95:level=disabled[mixed]',
    ].join(';');
  } else {
    graph = `${voice};[voice]alimiter=limit=0.95:level=disabled[mixed]`;
  }
  await runFfmpeg(
    [...inputs, '-filter_complex', graph, '-map', '[mixed]', '-t', total, '-ar', String(VOICE_SAMPLE_RATE), '-ac', '2', '-c:a', 'pcm_s16le', '-y', outputPath],
    TIMEOUT.render
  );
  return outputPath;
}

/** A 16 kHz mono copy of the voice track, the form lip-sync reads. */
export async function voiceTrackFor16k(voicePath: string, outputPath: string): Promise<string> {
  await runFfmpeg([...SAFE_INPUT_OPTIONS, '-i', voicePath, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', '-y', outputPath], TIMEOUT.render);
  return outputPath;
}

/**
 * Places each segment's take at its start and mixes it over an optional background bed —
 * the simple entry point (tests, and callers without measured onsets). The dub pipeline
 * uses the parts above directly so it can steer placement and levels.
 */
export async function stitchDubbedAudio(params: {
  segments: TimedAudioSegment[];
  totalDurationSeconds: number;
  pitch: number;
  speed: number;
  workDir: string;
  background?: {
    path: string;
    duckRegions: { start: number; end: number }[];
    /** Level the bed drops to across `duckRegions`: 0 mutes it (a raw source, where the original voice must not be heard). */
    duckLevel?: number;
  };
}): Promise<string> {
  const { segments, totalDurationSeconds, workDir, background } = params;
  await mkdir(workDir, { recursive: true });
  const placements = planPlacements(
    segments.map((s) => ({ start: s.startTime, end: s.endTime, rawSeconds: getWavDurationSeconds(s.audio) })),
    { totalSeconds: totalDurationSeconds, speed: params.speed, strict: false }
  );
  const voicePath = path.join(workDir, 'voice.wav');
  await renderVoiceTrack(
    segments.map((s, i) => ({ audio: s.audio, start: placements[i].start, tempo: placements[i].tempo, gainDb: s.gainDb })),
    { totalSeconds: totalDurationSeconds, pitch: params.pitch, outputPath: voicePath }
  );
  return mixDubAudio({
    voicePath,
    totalSeconds: totalDurationSeconds,
    outputPath: path.join(workDir, 'dubbed_audio.wav'),
    workDir,
    bed: background
      ? {
          path: background.path,
          spans: background.duckRegions.map((r) => ({ start: r.start, end: r.end, level: background.duckLevel ?? 0, attack: 0.04, release: 0.08 })),
        }
      : undefined,
  });
}
