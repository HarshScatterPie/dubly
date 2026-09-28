import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { captionRenderEnv } from './fonts';
import { ffmpeg, ffmpegPath, ffprobePath } from './mediaTools';

// Inputs may only be read from local files: a crafted file (e.g. a playlist) cannot make ffmpeg fetch URLs or other protocols.
export const SAFE_INPUT_OPTIONS = ['-protocol_whitelist', 'file,pipe'];

// Hard ceilings per operation (seconds); a malformed file that makes ffmpeg hang is killed instead of holding a slot forever.
const minutes = (name: string, fallback: number) => (Number(process.env[name]) || fallback) * 60;
export const TIMEOUT = {
  quick: minutes('FFMPEG_QUICK_TIMEOUT_MINUTES', 5),
  render: minutes('FFMPEG_RENDER_TIMEOUT_MINUTES', 120),
};
const PROBE_TIMEOUT_MS = 60_000;

function fromFile(input: string, timeoutSeconds = TIMEOUT.render) {
  return ffmpeg({ timeout: timeoutSeconds }).input(input).inputOptions(SAFE_INPUT_OPTIONS);
}

export interface MediaProbe {
  durationSeconds: number;
  width?: number;
  height?: number;
  hasAudio: boolean;
  hasVideo: boolean;
  // ffprobe's container name list, e.g. "mov,mp4,m4a,3gp,3g2,mj2" or "matroska,webm".
  formatName: string;
}

// ffprobe run directly (not through fluent-ffmpeg) so it gets the same protocol restriction and a timeout.
export function probeMedia(filePath: string): Promise<MediaProbe> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe could not read the file: ${err.message.split('\n')[0]}`));
        try {
          const data = JSON.parse(stdout) as {
            format?: { duration?: string; format_name?: string };
            streams?: { codec_type?: string; width?: number; height?: number }[];
          };
          const streams = data.streams || [];
          const videoStream = streams.find((s) => s.codec_type === 'video');
          const audioStream = streams.find((s) => s.codec_type === 'audio');
          resolve({
            durationSeconds: Number(data.format?.duration) || 0,
            width: videoStream?.width,
            height: videoStream?.height,
            hasAudio: Boolean(audioStream),
            hasVideo: Boolean(videoStream),
            formatName: data.format?.format_name || '',
          });
        } catch {
          reject(new Error('ffprobe returned unreadable output'));
        }
      }
    );
  });
}

export interface StreamLayout {
  durationSeconds: number;
  video?: {
    codec: string;
    pixFmt: string;
    /** As displayed: a phone video stored sideways with a rotation flag reports its upright size here. */
    width: number;
    height: number;
    fps: number;
    startTime: number;
  };
  audio?: { codec: string; startTime: number; channels: number; sampleRate: number };
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [num, den] = rate.split('/').map(Number);
  const value = den ? num / den : num;
  return Number.isFinite(value) && value > 0 && value < 1000 ? value : 0;
}

/** The first video and audio stream of a file: sizes, frame rate and where each stream starts on the timeline. */
export function probeStreams(filePath: string): Promise<StreamLayout> {
  return new Promise((resolve, reject) => {
    execFile(
      ffprobePath,
      ['-v', 'error', '-protocol_whitelist', 'file', '-print_format', 'json', '-show_format', '-show_streams', filePath],
      { timeout: PROBE_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) return reject(new Error(`ffprobe could not read the file: ${err.message.split('\n')[0]}`));
        try {
          type Stream = {
            codec_type?: string;
            codec_name?: string;
            pix_fmt?: string;
            width?: number;
            height?: number;
            avg_frame_rate?: string;
            r_frame_rate?: string;
            start_time?: string;
            channels?: number;
            sample_rate?: string;
            tags?: { rotate?: string };
            side_data_list?: { rotation?: number }[];
          };
          const data = JSON.parse(stdout) as { format?: { duration?: string }; streams?: Stream[] };
          const streams = data.streams || [];
          const v = streams.find((s) => s.codec_type === 'video' && s.codec_name !== 'mjpeg' && s.codec_name !== 'png');
          const a = streams.find((s) => s.codec_type === 'audio');
          const rotation = Number(v?.side_data_list?.find((d) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0);
          const sideways = Math.abs(rotation) % 180 === 90;
          resolve({
            durationSeconds: Number(data.format?.duration) || 0,
            video: v
              ? {
                  codec: v.codec_name || '',
                  pixFmt: v.pix_fmt || '',
                  width: (sideways ? v.height : v.width) || 0,
                  height: (sideways ? v.width : v.height) || 0,
                  fps: parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 25,
                  startTime: Number(v.start_time) || 0,
                }
              : undefined,
            audio: a
              ? { codec: a.codec_name || '', startTime: Number(a.start_time) || 0, channels: a.channels || 1, sampleRate: Number(a.sample_rate) || 0 }
              : undefined,
          });
        } catch {
          reject(new Error('ffprobe returned unreadable output'));
        }
      }
    );
  });
}

/**
 * How much later the source's audio starts than its picture. Transcript timings are measured
 * from the first audio sample, so a dub laid over the picture has to start that much later
 * too — otherwise every line lands early by exactly this offset (common in phone and
 * screen recordings, where it can be a few hundred milliseconds).
 */
export function audioLeadSeconds(layout: StreamLayout | null): number {
  if (!layout?.video || !layout.audio) return 0;
  const offset = layout.audio.startTime - layout.video.startTime;
  return Math.abs(offset) < 0.002 || Math.abs(offset) > 10 ? 0 : offset;
}

/** Extracts a 16kHz mono WAV track from a source video, ideal for STT accuracy. */
export function extractAudioForStt(inputPath: string, outputWavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fromFile(inputPath, TIMEOUT.render)
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('error', reject)
      .on('end', () => resolve())
      .save(outputWavPath);
  });
}

/** asetrate+aresample shifts pitch; the compensating atempo keeps the user's chosen speed independent of that shift. */
export function buildPitchSpeedFilter(pitch: number, speed: number, sampleRate: number): string {
  const pitchFactor = Math.min(1.3, Math.max(0.7, pitch || 1));
  const speedFactor = Math.min(1.5, Math.max(0.6, speed || 1));
  const newRate = Math.round(sampleRate * pitchFactor);
  const tempo = Math.min(2.0, Math.max(0.5, speedFactor / pitchFactor));
  return `asetrate=${newRate},aresample=${sampleRate},atempo=${tempo.toFixed(3)}`;
}

/** Applies the pitch/speed sliders to a single already-synthesized clip (used by the standalone TTS preview/generate endpoint, outside the per-segment dub timeline). */
export async function applyPitchSpeed(
  input: Buffer,
  pitch: number,
  speed: number,
  workDir: string
): Promise<Buffer> {
  if ((!pitch || pitch === 1) && (!speed || speed === 1)) return input;
  await mkdir(workDir, { recursive: true });
  const suffix = randomUUID();
  const inPath = path.join(workDir, `pitch_in_${suffix}.wav`);
  const outPath = path.join(workDir, `pitch_out_${suffix}.wav`);
  await writeFile(inPath, input);
  const filter = buildPitchSpeedFilter(pitch, speed, 24000);

  await new Promise<void>((resolve, reject) => {
    fromFile(inPath, TIMEOUT.quick)
      .audioFilters(filter)
      .audioCodec('pcm_s16le')
      .on('error', reject)
      .on('end', () => resolve())
      .save(outPath);
  });

  const result = await readFile(outPath);
  await Promise.all([rm(inPath, { force: true }), rm(outPath, { force: true })]);
  return result;
}

/**
 * How far a segment's delivery may be compressed to help it fit. Time-stretching speech
 * is only transparent within a narrow band: past roughly a third faster it stops sounding
 * like a person talking and starts sounding rushed. Forcing every segment to exactly fill
 * its original slot (the previous behaviour, which allowed up to 4x) is what made some
 * lines gabble and others drag, so the fit is now deliberately partial — start times stay
 * exact, and the delivery keeps its natural pace.
 */
export const MAX_COMPRESSION = 1.35;
/** Leave a little air before the next line rather than butting straight up against it. */
export const SEGMENT_GUARD_SECONDS = 0.08;

// How long a clip will actually play in the dub at the user's speed (same clamp as the voice track). Pitch is shifted without changing length.
export function effectiveClipSeconds(rawSeconds: number, _pitch: number, speed: number): number {
  const speedFactor = Math.min(1.5, Math.max(0.6, speed || 1));
  return rawSeconds / speedFactor;
}

/** Decomposes an arbitrary tempo factor into a chain of atempo filters, each kept within ffmpeg's valid single-filter range of [0.5, 2.0]. */
export function buildAtempoChain(factor: number): string {
  let f = Math.max(0.25, Math.min(4.0, factor));
  const parts: string[] = [];
  while (f > 2.0) {
    parts.push('atempo=2.0');
    f /= 2.0;
  }
  while (f < 0.5) {
    parts.push('atempo=0.5');
    f /= 0.5;
  }
  parts.push(`atempo=${f.toFixed(3)}`);
  return parts.join(',');
}

// ISO 639-2 codes for the audio track's language tag, so players list the dub by name.
const ISO_639_2: Record<string, string> = {
  hi: 'hin', hinglish: 'hin', ta: 'tam', te: 'tel', bn: 'ben', mr: 'mar', gu: 'guj', kn: 'kan', ml: 'mal', pa: 'pan',
  en: 'eng', es: 'spa', fr: 'fra', de: 'deu', pt: 'por', it: 'ita', ja: 'jpn', ko: 'kor', ar: 'ara', id: 'ind', zh: 'zho', ru: 'rus',
};

// Browsers play H.264 in 8-bit 4:2:0 everywhere; anything else (HEVC from iPhones, 10-bit, VP9 in MP4) is re-encoded so the export plays in every browser.
function playsEverywhere(layout: StreamLayout | null): boolean {
  if (!layout?.video) return true;
  return layout.video.codec === 'h264' && /^(yuv420p|yuvj420p)$/.test(layout.video.pixFmt || 'yuv420p');
}

/**
 * Lays the dubbed track under the picture: web-ready MP4 (moov atom first, so the player
 * starts before the whole file has downloaded), the picture copied untouched when browsers
 * can already play it, and the audio shifted by `audioOffsetSeconds` when the source's
 * sound started later (positive) or earlier (negative) than its picture.
 */
export async function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  opts: { audioOffsetSeconds?: number; languageCode?: string } = {}
): Promise<void> {
  const layout = await probeStreams(videoPath).catch(() => null);
  const offset = opts.audioOffsetSeconds ?? 0;
  const shift = (seconds: number) => (seconds > 0.001 ? ['-itsoffset', seconds.toFixed(3)] : []);
  const language = opts.languageCode ? ISO_639_2[opts.languageCode] : undefined;
  await runFfmpeg(
    [
      ...shift(-offset),
      ...SAFE_INPUT_OPTIONS,
      '-i', videoPath,
      ...shift(offset),
      ...SAFE_INPUT_OPTIONS,
      '-i', audioPath,
      '-map', '0:v:0',
      '-map', '1:a:0',
      ...(playsEverywhere(layout) ? ['-c:v', 'copy'] : ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p']),
      '-c:a', 'aac',
      '-b:a', '192k',
      ...(language ? ['-metadata:s:a:0', `language=${language}`] : []),
      '-movflags', '+faststart',
      '-shortest',
      '-y', outputPath,
    ],
    TIMEOUT.render
  );
}

/**
 * Adds the captions as a subtitle track players can switch on (VLC, QuickTime, phones, most
 * editors), without touching the picture or sound. Browsers ignore it; the app draws its own.
 */
export async function embedSubtitleTrack(videoPath: string, srtPath: string, outputPath: string, languageCode?: string): Promise<void> {
  const language = languageCode ? ISO_639_2[languageCode] : undefined;
  await runFfmpeg(
    [
      ...SAFE_INPUT_OPTIONS,
      '-i', videoPath,
      '-f', 'srt',
      ...SAFE_INPUT_OPTIONS,
      '-i', srtPath,
      '-map', '0:v:0',
      '-map', '0:a:0',
      '-map', '1:0',
      '-c:v', 'copy',
      '-c:a', 'copy',
      '-c:s', 'mov_text',
      ...(language ? ['-metadata:s:s:0', `language=${language}`] : []),
      '-metadata:s:s:0', 'handler_name=Dubly captions',
      '-movflags', '+faststart',
      '-y', outputPath,
    ],
    TIMEOUT.render
  );
}

/** Splits a WAV file into consecutive fixed-length chunks (used to work around Gemini's per-call inline-audio limit — see VERTEX_MAX_CHUNK_SECONDS in vertexClient.ts). Returns chunk file paths in order. */
export async function splitAudioIntoChunks(
  inputWavPath: string,
  chunkSeconds: number,
  workDir: string
): Promise<string[]> {
  await mkdir(workDir, { recursive: true });
  const pattern = path.join(workDir, 'chunk_%03d.wav');

  await new Promise<void>((resolve, reject) => {
    fromFile(inputWavPath)
      .outputOptions(['-f segment', `-segment_time ${chunkSeconds}`, '-c copy', '-reset_timestamps 1'])
      .on('error', reject)
      .on('end', () => resolve())
      .save(pattern);
  });

  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(workDir)).filter((f) => f.startsWith('chunk_') && f.endsWith('.wav')).sort();
  return files.map((f) => path.join(workDir, f));
}

/** Cuts a short audio-only clip out of a larger file, re-encoded to 16kHz mono WAV — used to build short per-speaker voice reference samples for chunked transcription. */
export function extractAudioClip(
  inputPath: string,
  startSeconds: number,
  durationSeconds: number,
  outputWavPath: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    fromFile(inputPath, TIMEOUT.quick)
      .setStartTime(Math.max(0, startSeconds))
      .duration(Math.max(0.1, durationSeconds))
      .noVideo()
      .audioCodec('pcm_s16le')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('error', reject)
      .on('end', () => resolve())
      .save(outputWavPath);
  });
}

/** Grabs a single representative frame as a JPEG for use as a project thumbnail. */
export function extractThumbnail(
  videoPath: string,
  outputJpgPath: string,
  atSeconds: number,
  durationSeconds: number
): Promise<void> {
  // Sample ~10% into the clip rather than frame 0, which is very often a black/blank
  // lead-in frame — but never past the clip's own length for short samples.
  const timestamp = Math.max(0, Math.min(atSeconds, Math.max(0, durationSeconds - 0.1)));
  return new Promise((resolve, reject) => {
    fromFile(videoPath, TIMEOUT.quick)
      .on('error', reject)
      .on('end', () => resolve())
      .screenshots({
        timestamps: [timestamp],
        filename: path.basename(outputJpgPath),
        folder: path.dirname(outputJpgPath),
        size: '480x?',
      });
  });
}

/** Escapes a filesystem path for use inside an ffmpeg filtergraph argument (colons and backslashes are filtergraph syntax characters — this matters especially on Windows, where drive-letter paths like `C:\...` would otherwise be misparsed). */
function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

/**
 * Burns an ASS subtitle file into the video for the "download with captions" export: the
 * picture is re-encoded at near-transparent quality, the audio copied untouched. Runs with
 * a fontconfig setup (fonts.ts), without which libass finds no fonts and draws nothing.
 */
export async function burnSubtitles(videoPath: string, assPath: string, outputPath: string): Promise<void> {
  await runFfmpeg(
    [
      ...SAFE_INPUT_OPTIONS,
      '-i', videoPath,
      '-vf', `subtitles='${escapeFilterPath(assPath)}'`,
      '-c:v', 'libx264',
      '-preset', 'medium',
      '-crf', '18',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'copy',
      // The captions are in the picture now; a switchable track as well would only show them twice.
      '-sn',
      '-movflags', '+faststart',
      '-y', outputPath,
    ],
    TIMEOUT.render,
    await captionRenderEnv()
  );
}

export function extractAudioOnly(videoPath: string, outputMp3Path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fromFile(videoPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioBitrate('192k')
      .on('error', reject)
      .on('end', () => resolve())
      .save(outputMp3Path);
  });
}

export interface LoudnessMeasurement {
  integrated: number;
  truePeak: number;
  range: number;
  threshold: number;
  offset: number;
}

// Where a dub may be levelled to; a near-silent or clipped-loud source is not a level worth copying.
export const LOUDNESS_FLOOR_LUFS = -24;
export const LOUDNESS_CEILING_LUFS = -12;
export const DEFAULT_LOUDNESS_LUFS = -16;
const TRUE_PEAK_DBTP = -1.5;
const LOUDNESS_RANGE_LU = 11;

// loudnorm prints its measurement as the last JSON object on stderr.
export function parseLoudnormOutput(stderr: string): LoudnessMeasurement | null {
  const start = stderr.lastIndexOf('{');
  const end = stderr.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const raw = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>;
    const m = {
      integrated: Number(raw.input_i),
      truePeak: Number(raw.input_tp),
      range: Number(raw.input_lra),
      threshold: Number(raw.input_thresh),
      offset: Number(raw.target_offset),
    };
    return Object.values(m).every(Number.isFinite) ? m : null;
  } catch {
    return null;
  }
}

export function runFfmpeg(args: string[], timeoutSeconds: number, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      ffmpegPath,
      ['-hide_banner', '-nostats', ...args],
      { timeout: timeoutSeconds * 1000, maxBuffer: 16 * 1024 * 1024, windowsHide: true, env },
      (err, _stdout, stderr) => (err ? reject(new Error(`ffmpeg failed: ${String(stderr).slice(-400)}`)) : resolve(String(stderr)))
    );
  });
}

// EBU R128 loudness of a file's audio (the measure streaming platforms normalise by); null when it cannot be measured.
export async function measureLoudness(filePath: string): Promise<LoudnessMeasurement | null> {
  try {
    const stderr = await runFfmpeg(
      [...SAFE_INPUT_OPTIONS, '-i', filePath, '-vn', '-af', `loudnorm=I=${DEFAULT_LOUDNESS_LUFS}:TP=${TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU}:print_format=json`, '-f', 'null', '-'],
      TIMEOUT.render
    );
    return parseLoudnormOutput(stderr);
  } catch {
    return null;
  }
}

// The loudness a dub should be levelled to: the original's own, kept inside sane bounds.
export function loudnessTarget(source: LoudnessMeasurement | null): number {
  if (!source || source.integrated < -60) return DEFAULT_LOUDNESS_LUFS;
  return Math.max(LOUDNESS_FLOOR_LUFS, Math.min(LOUDNESS_CEILING_LUFS, source.integrated));
}

// Second loudnorm pass: levels a WAV to `targetLufs` from its own measurement, linearly (one gain, no pumping) wherever the peaks allow. Channels are kept as they are.
export async function normalizeLoudness(inputPath: string, outputPath: string, targetLufs: number): Promise<boolean> {
  const measured = await measureLoudness(inputPath);
  if (!measured || measured.integrated < -60) return false;
  const filter = [
    `loudnorm=I=${targetLufs}:TP=${TRUE_PEAK_DBTP}:LRA=${LOUDNESS_RANGE_LU}`,
    `measured_I=${measured.integrated}:measured_TP=${measured.truePeak}:measured_LRA=${measured.range}`,
    `measured_thresh=${measured.threshold}:offset=${measured.offset}:linear=true:print_format=summary`,
  ].join(':');
  try {
    await runFfmpeg([...SAFE_INPUT_OPTIONS, '-i', inputPath, '-af', filter, '-ar', '48000', '-c:a', 'pcm_s16le', '-y', outputPath], TIMEOUT.render);
    return true;
  } catch {
    return false;
  }
}
