import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { getWavDurationSeconds } from './audioUtils';
import { ffmpeg, ffprobePath } from './mediaTools';

// Inputs may only be read from local files: a crafted file (e.g. a playlist) cannot make ffmpeg fetch URLs or other protocols.
const SAFE_INPUT_OPTIONS = ['-protocol_whitelist', 'file,pipe'];

// Hard ceilings per operation (seconds); a malformed file that makes ffmpeg hang is killed instead of holding a slot forever.
const minutes = (name: string, fallback: number) => (Number(process.env[name]) || fallback) * 60;
const TIMEOUT = {
  quick: minutes('FFMPEG_QUICK_TIMEOUT_MINUTES', 5),
  render: minutes('FFMPEG_RENDER_TIMEOUT_MINUTES', 120),
};
const PROBE_TIMEOUT_MS = 60_000;
// Generated silence (lavfi) is selected with a raw -f option: newer ffmpeg lists lavfi under -devices, which fluent-ffmpeg's format check does not read.

function fromFile(input: string, timeoutSeconds = TIMEOUT.render) {
  return ffmpeg({ timeout: timeoutSeconds }).input(input).inputOptions(SAFE_INPUT_OPTIONS);
}

function addFile(command: ReturnType<typeof ffmpeg>, input: string) {
  return command.input(input).inputOptions(SAFE_INPUT_OPTIONS);
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

export interface TimedAudioSegment {
  startTime: number;
  endTime: number;
  audio: Buffer;
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

// How long a clip will actually play in the dub once the user's pitch/speed are applied (same clamps as the stitcher).
export function effectiveClipSeconds(rawSeconds: number, pitch: number, speed: number): number {
  const pitchFactor = Math.min(1.3, Math.max(0.7, pitch || 1));
  const speedFactor = Math.min(1.5, Math.max(0.6, speed || 1));
  return rawSeconds / pitchFactor / speedFactor;
}

/** Decomposes an arbitrary tempo factor into a chain of atempo filters, each kept within ffmpeg's valid single-filter range of [0.5, 2.0]. */
function buildAtempoChain(factor: number): string {
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

/**
 * Places each segment's TTS audio at its original startTime and mixes them into a
 * single track exactly `totalDurationSeconds` long, so the dubbed track stays aligned
 * with the source video's cut points when later muxed back in. Crucially, each
 * segment's audio is also time-fitted (sped up or slowed down) to exactly match its
 * original `endTime - startTime` slot — translated speech is essentially never the same
 * length as the source line, so without this the dubbed track drifts into audible gaps
 * or overlaps between lines instead of sounding continuous like the original.
 */
export async function stitchDubbedAudio(params: {
  segments: TimedAudioSegment[];
  totalDurationSeconds: number;
  pitch: number;
  speed: number;
  workDir: string;
  /**
   * Audio to keep underneath the dub. Without this the dubbed track is speech on silence,
   * which strips everything that isn't the speaker — applause, music, ambience — out of
   * the finished video. `duckRegions` are spans to silence in that bed (i.e. where the
   * dubbed voice plays); pass none when the bed is already a vocals-removed stem.
   */
  background?: {
    path: string;
    duckRegions: { start: number; end: number }[];
    /** Level the bed drops to across `duckRegions`. 0 fully mutes it (right for a raw source track, where the original voice must not be heard); a small non-zero value only attenuates, which suppresses whatever vocal residue separation left behind while keeping the music audible. */
    duckLevel?: number;
  };
}): Promise<string> {
  const { segments, totalDurationSeconds, pitch, speed, workDir, background } = params;
  await mkdir(workDir, { recursive: true });
  // 48kHz so the background bed keeps its fidelity; TTS clips are upsampled into it.
  const sampleRate = 48000;
  const outputPath = path.join(workDir, 'dubbed_audio.wav');

  if (segments.length === 0) {
    return new Promise((resolve, reject) => {
      const cmd = background
        ? fromFile(background.path)
        : ffmpeg({ timeout: TIMEOUT.render }).input(`anullsrc=r=${sampleRate}:cl=mono`).inputOptions(['-f', 'lavfi']);
      cmd
        .duration(Math.max(1, totalDurationSeconds))
        .audioCodec('pcm_s16le')
        .audioFrequency(sampleRate)
        .audioChannels(1)
        .on('error', reject)
        .on('end', () => resolve(outputPath))
        .save(outputPath);
    });
  }

  const segmentPaths: string[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segPath = path.join(workDir, `seg_${i}.wav`);
    await writeFile(segPath, segments[i].audio);
    segmentPaths.push(segPath);
  }

  const pitchFactor = Math.min(1.3, Math.max(0.7, pitch || 1));
  const userSpeedFactor = Math.min(1.5, Math.max(0.6, speed || 1));
  const newRate = Math.round(sampleRate * pitchFactor);

  const filterParts: string[] = [];
  const mixLabels: string[] = [];

  if (background) {
    // `volume`'s timeline `enable` mutes the bed only while the dubbed voice is speaking,
    // so the original speaker is never heard under the dub, while everything between the
    // lines (applause, music, room tone) is passed through untouched.
    const duck = background.duckRegions.length
      ? `,volume=volume=${(background.duckLevel ?? 0).toFixed(3)}:enable='${background.duckRegions
          .map((r) => `between(t,${Math.max(0, r.start).toFixed(3)},${r.end.toFixed(3)})`)
          .join('+')}'`
      : '';
    // `apad` for the same reason as on the segments below, plus it guarantees the mixed
    // track covers the video's full length even when the bed is fractionally shorter —
    // otherwise `-shortest` at mux time would trim the tail off the picture.
    filterParts.push(`[0:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono${duck},apad[bed]`);
    mixLabels.push('bed');
  } else {
    mixLabels.push('0:a');
  }

  segments.forEach((seg, i) => {
    const delayMs = Math.max(0, Math.round(seg.startTime * 1000));
    const label = `a${i}`;

    // Each line starts exactly on time; only its *pace* is negotiable. A translated line
    // is rarely the same length as the source, so rather than stretching it to fill the
    // slot exactly (which made short lines drag and long ones gabble), it may run on into
    // the pause before the next line and is compressed only if it still doesn't fit —
    // and never past the point where delivery stops sounding natural.
    const targetDuration = Math.max(0.2, seg.endTime - seg.startTime);
    const nextStart = i + 1 < segments.length ? segments[i + 1].startTime : totalDurationSeconds;
    const availableDuration = Math.max(targetDuration, nextStart - seg.startTime - SEGMENT_GUARD_SECONDS);

    const rawDuration = getWavDurationSeconds(seg.audio) || targetDuration;
    const postPitchDuration = rawDuration / pitchFactor; // asetrate below shifts duration by pitchFactor as a side effect

    // Baseline is the user's chosen pace; speeding past it is a last resort and slowing
    // below it (just to pad out a short line) is never done.
    let tempo = userSpeedFactor;
    if (postPitchDuration / userSpeedFactor > availableDuration) {
      tempo = Math.min(postPitchDuration / availableDuration, userSpeedFactor * MAX_COMPRESSION);
    }
    const atempoChain = buildAtempoChain(tempo);

    // The trailing `apad` is what keeps the mix levels honest — see the amix note below.
    filterParts.push(
      `[${i + 1}:a]aformat=sample_rates=${sampleRate}:channel_layouts=mono,asetrate=${newRate},aresample=${sampleRate},${atempoChain},adelay=${delayMs}|${delayMs},apad[${label}]`
    );
    mixLabels.push(label);
  });

  // amix divides by its input count, so the `volume` below multiplies that back out to
  // leave every input at its natural level. That only holds while the input count is
  // constant: amix re-normalizes over the inputs still *running*, so as each segment hit
  // EOF the surviving inputs were boosted a step, and the fixed multiplier stopped
  // compensating. Measured on a 3-segment mix, the background bed climbed 12dB (exactly
  // the 4x input count) from start to end — inaudible under the first line, clipping by
  // the last, and stepping up at every segment boundary in between. Padding each input to
  // run the whole length keeps the count constant, so the compensation stays exact.
  // (Kept rather than amix's `normalize=0`, so the mix behaves the same on older OS-packaged ffmpeg builds too.)
  // The limiter then catches the peaks where a line and a loud bed genuinely coincide,
  // instead of letting them wrap around as clipping.
  filterParts.push(
    `[${mixLabels.join('][')}]amix=inputs=${mixLabels.length}:duration=first:dropout_transition=0,volume=${mixLabels.length},alimiter=limit=0.97:level=disabled[mixed]`
  );

  return new Promise((resolve, reject) => {
    const command = background
      ? fromFile(background.path).duration(Math.max(1, totalDurationSeconds))
      : ffmpeg({ timeout: TIMEOUT.render })
          .input(`anullsrc=r=${sampleRate}:cl=mono`)
          .inputOptions(['-f', 'lavfi'])
          .duration(Math.max(1, totalDurationSeconds));

    for (const segPath of segmentPaths) {
      addFile(command, segPath);
    }

    command
      .complexFilter(filterParts, 'mixed')
      .audioCodec('pcm_s16le')
      .on('error', reject)
      .on('end', () => resolve(outputPath))
      .save(outputPath);
  });
}

/** Replaces the source video's audio stream with the dubbed track; the video stream is copied untouched (no re-encode, no lip-sync). */
export function muxVideoWithAudio(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    addFile(fromFile(videoPath), audioPath)
      .outputOptions(['-map 0:v:0', '-map 1:a:0', '-c:v copy', '-c:a aac', '-b:a 192k', '-shortest'])
      .on('error', reject)
      .on('end', () => resolve())
      .save(outputPath);
  });
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

/** Burns an ASS subtitle file into the video (video re-encode, audio stream copied untouched) — used for the optional "download with captions" export. */
export function burnSubtitles(videoPath: string, assPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    fromFile(videoPath)
      .videoFilters(`subtitles='${escapeFilterPath(assPath)}'`)
      .outputOptions(['-c:a copy'])
      .on('error', reject)
      .on('end', () => resolve())
      .save(outputPath);
  });
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
