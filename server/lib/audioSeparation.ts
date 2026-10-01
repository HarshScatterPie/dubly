import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, SAFE_INPUT_OPTIONS, TIMEOUT } from './ffmpeg';
import { serverRoot } from './paths';

/**
 * Splits the source audio into speech and everything else, so a dub can replace only the
 * speaker while the rest of the soundtrack keeps playing underneath it.
 *
 * DeepFilterNet3 (MIT/Apache-2.0, a single static binary that deploy/vm/deploy.sh installs)
 * pulls the speech out; the background is what is left once that speech is subtracted from
 * the source. It is built for noise rather than music, so a loud music bed can keep a trace
 * of the voice; callers treat separation as optional and fall back to ducking the raw source.
 * It runs on one CPU core at a few times real time, in chunks so memory stays flat
 * (~350 MB) however long the video is.
 */
export const SEPARATION_MODEL = 'deepfilternet3';

const BINARY = process.env.DEEP_FILTER_PATH || path.join(serverRoot, 'bin', process.platform === 'win32' ? 'deep-filter.exe' : 'deep-filter');

// DeepFilterNet's native rate; the stems are 16-bit stereo, 4 bytes a frame.
const RATE = 48_000;
// The binary holds a whole file in memory (~65 MB a minute of stereo), so long audio goes through in pieces.
const CHUNK_FRAMES = 300 * RATE;
// Every chunk after the first starts this much early and the extra is dropped, so the model has settled by the audio that is kept.
const LEAD_IN_FRAMES = 2 * RATE;
// Silence after each chunk, so delay compensation never trims audio that is kept off its end.
const TAIL_PAD_FRAMES = RATE / 2;

export function isSeparationAvailable(): boolean {
  return existsSync(BINARY);
}

export interface SeparatedStems {
  /** Everything but the voice: music, ambience, effects. */
  background: string;
  vocals: string;
}

// Frames in a 16-bit stereo WAV written by ffmpeg, read from its data chunk header.
async function wavFrames(file: string): Promise<number> {
  const handle = await open(file, 'r');
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(4096), 0, 4096, 0);
    for (let at = 12; at + 8 <= bytesRead; ) {
      const size = buffer.readUInt32LE(at + 4);
      if (buffer.toString('latin1', at, at + 4) === 'data') return Math.floor(size / 4);
      at += 8 + size + (size % 2);
    }
  } finally {
    await handle.close();
  }
  throw new Error('decoded audio has no data chunk');
}

function runDeepFilter(input: string, outDir: string, seconds: number): Promise<void> {
  // Well under real time on one core; the ceiling leaves room for a busy, shared-core machine.
  const timeout = Math.max(10 * 60_000, seconds * 4_000);
  return new Promise((resolve, reject) => {
    execFile(BINARY, ['--compensate-delay', '-o', outDir, input], { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, _stdout, stderr) =>
      err ? reject(new Error(`deep-filter failed: ${String(stderr).slice(-400) || err.message}`)) : resolve()
    );
  });
}

/**
 * Separates `mediaPath` into stems under `workDir`, or returns null when that is not
 * possible — callers must handle null rather than assume success.
 */
export async function separateStems(mediaPath: string, workDir: string, opts: { onProgress?: (fraction: number) => void } = {}): Promise<SeparatedStems | null> {
  if (!isSeparationAvailable()) return null;
  const dir = path.join(workDir, 'separated');
  const source = path.join(dir, 'source.wav');
  const vocals = path.join(dir, 'vocals.wav');
  const background = path.join(dir, 'background.wav');
  const parts: string[] = [];
  try {
    await mkdir(dir, { recursive: true });
    await runFfmpeg([...SAFE_INPUT_OPTIONS, '-i', mediaPath, '-vn', '-ac', '2', '-ar', String(RATE), '-c:a', 'pcm_s16le', '-y', source], TIMEOUT.render);
    const frames = await wavFrames(source);
    if (!frames) return null;

    const count = Math.ceil(frames / CHUNK_FRAMES);
    for (let i = 0; i < count; i++) {
      const start = i * CHUNK_FRAMES;
      const lead = Math.min(LEAD_IN_FRAMES, start);
      const length = Math.min(CHUNK_FRAMES, frames - start);
      const chunk = path.join(dir, `chunk_${i}.wav`);
      const outDir = path.join(dir, `speech_${i}`);
      const part = path.join(dir, `vocals_${i}.wav`);
      await runFfmpeg(
        [...SAFE_INPUT_OPTIONS, '-i', source, '-af', `atrim=start_sample=${start - lead}:end_sample=${start + length},asetpts=N/SR/TB,apad=pad_len=${TAIL_PAD_FRAMES}`, '-c:a', 'pcm_s16le', '-y', chunk],
        TIMEOUT.render
      );
      await runDeepFilter(chunk, outDir, (lead + length) / RATE);
      await runFfmpeg(
        [...SAFE_INPUT_OPTIONS, '-i', path.join(outDir, `chunk_${i}.wav`), '-af', `atrim=start_sample=${lead}:end_sample=${lead + length},asetpts=N/SR/TB`, '-c:a', 'pcm_s16le', '-y', part],
        TIMEOUT.render
      );
      await Promise.all([rm(chunk, { force: true }), rm(outDir, { recursive: true, force: true })]);
      parts.push(part);
      opts.onProgress?.((i + 1) / count);
    }

    if (parts.length === 1) {
      await rename(parts[0], vocals);
    } else {
      const inputs = parts.flatMap((p) => ['-i', p]);
      const joined = `${parts.map((_, i) => `[${i}:a]`).join('')}concat=n=${parts.length}:v=0:a=1[speech]`;
      await runFfmpeg([...SAFE_INPUT_OPTIONS, ...inputs, '-filter_complex', joined, '-map', '[speech]', '-c:a', 'pcm_s16le', '-y', vocals], TIMEOUT.render);
    }
    // Background = source minus speech, channel by channel; both are sample-aligned at the same length.
    await runFfmpeg(
      [...SAFE_INPUT_OPTIONS, '-i', source, '-i', vocals, '-filter_complex', '[0:a][1:a]amerge=inputs=2,pan=stereo|c0=c0-c2|c1=c1-c3[bed]', '-map', '[bed]', '-c:a', 'pcm_s16le', '-y', background],
      TIMEOUT.render
    );
    return { background, vocals };
  } catch (err) {
    console.error('[audioSeparation] failed, falling back to ducking', err);
    return null;
  } finally {
    await Promise.all([source, ...parts].map((f) => rm(f, { force: true })));
  }
}
