import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { FaceScan } from '../../src/types';
import { FACE_DETECTOR } from './lipSync';
import { ffmpegPath } from './mediaTools';
import { lipsyncDir, venvPython } from './paths';

/**
 * Looks at a dozen or so frames of an uploaded video to tell whether someone's face is on
 * screen — the case where a dub that ignores the mouth looks wrong, and lip-sync is worth
 * offering. Uses the same face detector as lip-sync itself, in a light script (numpy,
 * OpenCV, onnxruntime) that starts in about a second.
 */
const SCRIPT = path.join(lipsyncDir, 'dubly_face_scan.py');

export function isFaceScanAvailable(): boolean {
  return existsSync(venvPython) && existsSync(SCRIPT) && existsSync(FACE_DETECTOR);
}

// A face in at least this share of samples, covering at least this much of the frame (~110 px tall at 1080p).
const MIN_FACE_SHARE = 0.3;
const MIN_FACE_AREA = 0.005;

export function faceScanVerdict(scan: Omit<FaceScan, 'hasFaces' | 'scannedAt'>): boolean {
  if (!scan.sampledFrames) return false;
  return scan.framesWithFace / scan.sampledFrames >= MIN_FACE_SHARE && scan.medianFaceArea >= MIN_FACE_AREA;
}

/** The scan, or null when it cannot run or fails; a missing scan never blocks anything. */
export function scanFaces(videoPath: string, durationSeconds: number, timeoutMs = 90_000): Promise<FaceScan | null> {
  if (!isFaceScanAvailable() || !(durationSeconds > 0)) return Promise.resolve(null);
  const samples = durationSeconds > 600 ? 16 : 12;
  return new Promise((resolve) => {
    const proc = spawn(
      venvPython,
      [SCRIPT, '--ffmpeg', ffmpegPath, '--video', videoPath, '--duration', durationSeconds.toFixed(2), '--samples', String(samples), '--detector', FACE_DETECTOR],
      { cwd: lipsyncDir, windowsHide: true }
    );
    let out = '';
    let err = '';
    proc.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    proc.stderr.on('data', (chunk: Buffer) => (err = (err + chunk.toString()).slice(-1500)));
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    proc.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      const line = out.trim().split(/\r?\n/).pop() || '';
      if (code !== 0 || !line.startsWith('{')) {
        console.error(`[faceScan] exited ${code}: ${err}`);
        resolve(null);
        return;
      }
      try {
        const raw = JSON.parse(line) as Omit<FaceScan, 'hasFaces' | 'scannedAt'>;
        resolve({ ...raw, hasFaces: faceScanVerdict(raw), scannedAt: new Date().toISOString() });
      } catch {
        resolve(null);
      }
    });
  });
}
