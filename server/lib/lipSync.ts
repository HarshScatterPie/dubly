import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { ffmpegDir } from './mediaTools';
import { lipsyncDir } from './paths';

/**
 * Free, self-hosted lip-sync via a CPU-friendly ONNX build of Wav2Lip
 * (github.com/instant-high/wav2lip-onnx-256) — chosen over the more popular
 * "Easy-Wav2Lip" fork specifically because that one hard-requires an Nvidia/Apple
 * Silicon GPU for local use, which this machine doesn't have. Verified working
 * end-to-end against a real sample clip during setup: ~15x realtime on this CPU (a
 * 6s clip took ~88s), which is why this is opt-in and communicated as slow rather
 * than default-on. Two small compatibility patches were applied to the vendored copy
 * in wav2lip_onnx/: a numpy 2.x array-to-scalar fix in
 * insightface_func/face_detect_crop_single.py, and a path-separator-robust
 * checkpoint-name check in inference_onnxModel.py.
 */
const REPO_DIR = path.join(lipsyncDir, 'wav2lip_onnx');
const VENV_PYTHON = path.join(lipsyncDir, 'venv', 'Scripts', 'python.exe');
const CHECKPOINT_PATH = path.join(REPO_DIR, 'checkpoints', 'wav2lip_256.onnx');
const INFERENCE_SCRIPT = 'inference_onnxModel.py';

export function isLipSyncAvailable(): boolean {
  return existsSync(VENV_PYTHON) && existsSync(CHECKPOINT_PATH);
}

/**
 * Runs the lip-sync pass on an already-muxed video (video + final dubbed audio) and
 * writes the result to outputPath. Requires the video to contain a visible face in
 * (ideally) every frame — throws if none is detected, which callers should treat as a
 * soft failure (fall back to the non-lip-synced video) rather than failing the whole
 * dub, since this is a best-effort enhancement, not a core requirement.
 */
export async function runLipSync(videoPath: string, outputPath: string): Promise<void> {
  if (!isLipSyncAvailable()) {
    throw new Error('Lip-sync is not set up on this server (missing venv or model checkpoint)');
  }
  // The inference script writes its own intermediate files (temp.wav, result.avi) to a
  // `temp/` dir relative to its cwd rather than accepting a configurable output dir —
  // ensure it exists rather than assuming it survived being vendored in.
  await mkdir(path.join(REPO_DIR, 'temp'), { recursive: true });

  return new Promise((resolve, reject) => {
    const proc = spawn(
      VENV_PYTHON,
      [
        '-W',
        'ignore',
        INFERENCE_SCRIPT,
        '--checkpoint_path',
        CHECKPOINT_PATH,
        '--face',
        videoPath,
        '--audio',
        videoPath, // the muxed video's own audio track is the (already dubbed) speech to sync to
        '--outfile',
        outputPath,
        '--nosmooth',
        '--pads',
        '0',
        '10',
        '0',
        '0',
      ],
      {
        cwd: REPO_DIR,
        // The inference script shells out to a bare `ffmpeg` internally — prepend our
        // bundled ffmpeg binary's directory so the child process can find it without
        // requiring a system-wide ffmpeg install.
        env: { ...process.env, PATH: `${ffmpegDir}${path.delimiter}${process.env.PATH || ''}` },
      }
    );

    let stderrTail = '';
    proc.stderr.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-4000);
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Lip-sync process exited with code ${code}: ${stderrTail}`));
    });
  });
}
