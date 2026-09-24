import { createRequire } from 'node:module';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const require = createRequire(import.meta.url);

/**
 * Which ffmpeg/ffprobe binaries run. Production sets FFMPEG_PATH/FFPROBE_PATH to the OS package (security-patched through the
 * base image, see Dockerfile); without them the npm-bundled builds are used, which is what local development relies on.
 */
export const ffmpegPath: string = process.env.FFMPEG_PATH || (require('ffmpeg-static') as string);
export const ffprobePath: string = process.env.FFPROBE_PATH || ffprobeInstaller.path;
// Prepended to PATH for the Python helpers (lip-sync, separation, cloning), which shell out to `ffmpeg` themselves.
export const ffmpegDir = path.dirname(ffmpegPath);

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

export { ffmpeg };
