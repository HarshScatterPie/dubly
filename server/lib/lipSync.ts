import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { ffmpegPath } from './mediaTools';
import { lipsyncDir, venvPython } from './paths';

/**
 * Self-hosted lip-sync: Wav2Lip-256 (ONNX, CPU) driven by `lipsync/dubly_lipsync.py`.
 *
 * The script streams frames through ffmpeg at a constant frame rate (so variable-rate phone
 * video no longer drifts out of sync), re-animates only the mouth of the tracked speaker
 * from the dubbed *voice* track (not the music bed), and passes every frame without speech
 * or without a usable face through untouched. It writes video only; the caller muxes the
 * finished soundtrack onto it. Each run uses its own files, so parallel dubs cannot clobber
 * each other the way the vendored script's shared temp/ folder did.
 */
const SCRIPT = path.join(lipsyncDir, 'dubly_lipsync.py');
const CHECKPOINT = path.join(lipsyncDir, 'wav2lip_onnx', 'checkpoints', 'wav2lip_256.onnx');
export const FACE_DETECTOR = path.join(lipsyncDir, 'wav2lip_onnx', 'insightface_func', 'models', 'antelope', 'scrfd_2.5g_bnkps.onnx');

export function isLipSyncAvailable(): boolean {
  return existsSync(venvPython) && existsSync(SCRIPT) && existsSync(CHECKPOINT) && existsSync(FACE_DETECTOR);
}

// Lip-sync never runs above this rate: it costs a model pass per frame, and 30 fps is plenty for a mouth.
const MAX_FPS = 30;

export function lipSyncFps(sourceFps: number): number {
  if (!(sourceFps > 0)) return 25;
  return Math.round(Math.min(MAX_FPS, sourceFps) * 1000) / 1000;
}

export interface LipSyncResult {
  frames: number;
  synced: number;
}

export async function runLipSync(opts: {
  videoPath: string;
  /** The dubbed voice alone, 16 kHz mono. */
  voiceWavPath: string;
  /** Video-only MP4 to write. */
  outputPath: string;
  fps: number;
  durationSeconds: number;
  /** Where anyone is speaking (the original or the dub); frames outside them are left as they are. */
  spans: { start: number; end: number }[];
  workDir: string;
  onProgress?: (fraction: number) => void;
}): Promise<LipSyncResult> {
  if (!isLipSyncAvailable()) throw new Error('Lip-sync is not set up on this server (missing venv, script or model files)');
  const spansPath = path.join(opts.workDir, 'lipsync_spans.json');
  await writeFile(spansPath, JSON.stringify(opts.spans.map((s) => [Number(s.start.toFixed(3)), Number(s.end.toFixed(3))])), 'utf8');
  // About a model pass per frame on CPU; the ceiling is generous because a stuck run is killed, not charged.
  const timeoutMs =
    (Number(process.env.LIPSYNC_TIMEOUT_MINUTES) || 0) * 60_000 || Math.min(8 * 3600_000, Math.max(30 * 60_000, opts.durationSeconds * 45_000));

  return new Promise((resolve, reject) => {
    const proc = spawn(
      venvPython,
      [
        SCRIPT,
        '--ffmpeg', ffmpegPath,
        '--video', opts.videoPath,
        '--audio', opts.voiceWavPath,
        '--out', opts.outputPath,
        '--fps', String(opts.fps),
        '--duration', opts.durationSeconds.toFixed(3),
        '--spans', spansPath,
        '--checkpoint', CHECKPOINT,
        '--detector', FACE_DETECTOR,
      ],
      { cwd: lipsyncDir, windowsHide: true, env: { ...process.env, PYTHONUNBUFFERED: '1' } }
    );

    let stdoutBuffer = '';
    let stderrTail = '';
    let result: LipSyncResult | null = null;
    proc.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        const progress = /^PROGRESS\s+([\d.]+)/.exec(line);
        if (progress) opts.onProgress?.(Math.min(1, Number(progress[1])));
        const done = /^RESULT\s+(\{.*\})/.exec(line);
        if (done) {
          try {
            result = JSON.parse(done[1]) as LipSyncResult;
          } catch {
            // reported as a failure below
          }
        }
      }
    });
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });

    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && result && existsSync(opts.outputPath)) resolve(result);
      else reject(new Error(`Lip-sync exited with code ${code}: ${stderrTail}`));
    });
  });
}
