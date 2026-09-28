import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runFfmpeg, SAFE_INPUT_OPTIONS, TIMEOUT } from './ffmpeg';
import { ffmpegDir, ffprobePath } from './mediaTools';
import { venvPython, venvSitePackages } from './paths';

/**
 * Splits the source audio into vocals and everything-else, so a dub can replace only the
 * speaker while keeping the rest of the soundtrack.
 *
 * Without this, preserving background audio means muting the source wherever the original
 * speaker talks — which keeps applause and music *between* lines but loses whatever was
 * playing *underneath* them. With the stems, the music bed keeps playing under the dub, and
 * the vocals stem gives a clean measure of where and how loud the original speaker is.
 *
 * Runs Demucs locally on CPU (no API, no per-minute cost). It is slow, so callers treat it
 * as an optional enhancement and fall back to ducking the raw source when it fails.
 */
const VENV_PYTHON = venvPython;

// Demucs' default hybrid transformer. `htdemucs_ft` separates voices a little more cleanly at
// roughly four times the CPU; set DEMUCS_MODEL to switch. (The quantized mdx_extra_q needs
// `diffq`, which has no prebuilt Windows wheel.)
export const SEPARATION_MODEL = process.env.DEMUCS_MODEL || 'htdemucs';

export function isSeparationAvailable(): boolean {
  if (!existsSync(VENV_PYTHON)) return false;
  return existsSync(path.join(venvSitePackages(), 'demucs'));
}

export interface SeparatedStems {
  /** Everything but the voice: music, ambience, effects. */
  background: string;
  vocals: string;
}

/**
 * Separates `mediaPath` into stems under `workDir`, or returns null when that is not
 * possible — callers must handle null rather than assume success.
 *
 * The audio is decoded to WAV first: Demucs otherwise decodes the container itself and
 * falls back to shelling out to `ffprobe`, which is not on the helper's PATH, so any
 * source its own decoder could not read (much of what phones and screen recorders make)
 * silently failed to separate.
 */
export async function separateStems(
  mediaPath: string,
  workDir: string,
  opts: { durationSeconds: number; onProgress?: (fraction: number) => void }
): Promise<SeparatedStems | null> {
  if (!isSeparationAvailable()) return null;
  const outDir = path.join(workDir, 'separated');
  await mkdir(outDir, { recursive: true });
  const inputWav = path.join(workDir, 'separation_input.wav');
  try {
    await runFfmpeg([...SAFE_INPUT_OPTIONS, '-i', mediaPath, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', '-y', inputWav], TIMEOUT.render);
  } catch (err) {
    console.error('[audioSeparation] could not decode the source audio', err);
    return null;
  }

  // CPU Demucs runs at roughly 1-3x real time; the ceiling leaves room for a busy machine.
  const timeoutMs = Math.min(4 * 3600_000, Math.max(20 * 60_000, opts.durationSeconds * 6_000));
  return new Promise((resolve) => {
    const proc = spawn(VENV_PYTHON, ['-m', 'demucs', '--two-stems', 'vocals', '-n', SEPARATION_MODEL, '--out', outDir, inputWav], {
      cwd: workDir,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PATH: [ffmpegDir, path.dirname(ffprobePath), process.env.PATH || ''].join(path.delimiter),
      },
    });

    let stderrTail = '';
    let lastReported = -1;
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrTail = (stderrTail + text).slice(-2000);
      // tqdm's bar: " 42%|████▏     | 12.3/29.2 [...]"
      const matches = [...text.matchAll(/(\d{1,3})%\|/g)];
      const percent = matches.length ? Number(matches[matches.length - 1][1]) : NaN;
      if (Number.isFinite(percent) && percent !== lastReported && opts.onProgress) {
        lastReported = percent;
        opts.onProgress(Math.min(1, percent / 100));
      }
    });
    proc.stdout.on('data', () => undefined);

    const timer = setTimeout(() => {
      proc.kill();
      console.error('[audioSeparation] timed out, falling back to ducking');
      resolve(null);
    }, timeoutMs);

    proc.on('error', (err) => {
      clearTimeout(timer);
      console.error('[audioSeparation] failed to start', err);
      resolve(null);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        console.error(`[audioSeparation] exited ${code}: ${stderrTail}`);
        resolve(null);
        return;
      }
      const stemDir = path.join(outDir, SEPARATION_MODEL, path.parse(inputWav).name);
      const background = path.join(stemDir, 'no_vocals.wav');
      const vocals = path.join(stemDir, 'vocals.wav');
      resolve(existsSync(background) && existsSync(vocals) ? { background, vocals } : null);
    });
  });
}
