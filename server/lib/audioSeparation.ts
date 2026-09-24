import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ffmpegDir } from './mediaTools';
import { lipsyncDir } from './paths';

/**
 * Splits the source audio into vocals and everything-else, so a dub can replace only the
 * speaker while keeping the rest of the soundtrack.
 *
 * Without this, preserving background audio means muting the source wherever the dubbed
 * voice plays — which keeps applause and music *between* lines but still loses whatever
 * was playing *underneath* the speaker. Separation removes that compromise: the bed keeps
 * playing continuously because the original voice is gone from it rather than muted.
 *
 * Runs Demucs locally on CPU (no API, no per-minute cost). It is slow, so callers treat
 * it as an optional enhancement and fall back to ducking when it is unavailable.
 */
const VENV_PYTHON = path.join(lipsyncDir, 'venv', 'Scripts', 'python.exe');

// Demucs' default model. The faster quantized variant (mdx_extra_q) needs `diffq`, which
// has no prebuilt Windows wheel and fails to compile without a C toolchain, so it isn't a
// usable default here.
const MODEL = 'htdemucs';

export function isSeparationAvailable(): boolean {
  if (!existsSync(VENV_PYTHON)) return false;
  return existsSync(path.join(lipsyncDir, 'venv', 'Lib', 'site-packages', 'demucs'));
}

/**
 * Returns the path to a "no vocals" version of the given media's audio, or null if
 * separation isn't possible — callers must handle null rather than assume success.
 */
export function separateBackground(mediaPath: string, workDir: string, timeoutMs = 20 * 60 * 1000): Promise<string | null> {
  return new Promise((resolve) => {
    if (!isSeparationAvailable()) {
      resolve(null);
      return;
    }

    const outDir = path.join(workDir, 'separated');
    const proc = spawn(
      VENV_PYTHON,
      ['-m', 'demucs', '--two-stems', 'vocals', '-n', MODEL, '--out', outDir, mediaPath],
      {
        cwd: workDir,
        // Demucs shells out to ffmpeg for decoding.
        env: { ...process.env, PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}` },
      }
    );

    let stderrTail = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

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
      const stem = path.join(outDir, MODEL, path.parse(mediaPath).name, 'no_vocals.wav');
      resolve(existsSync(stem) ? stem : null);
    });
  });
}
