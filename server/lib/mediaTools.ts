import { createRequire } from 'node:module';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const require = createRequire(import.meta.url);

// ffmpeg/ffprobe binaries: FFMPEG_PATH/FFPROBE_PATH in production (OS package), otherwise the npm-bundled builds.
export const ffmpegPath: string = process.env.FFMPEG_PATH || (require('ffmpeg-static') as string);
export const ffprobePath: string = process.env.FFPROBE_PATH || ffprobeInstaller.path;
// Prepended to PATH for the Python helpers (lip-sync, separation, cloning), which shell out to `ffmpeg` themselves.
export const ffmpegDir = path.dirname(ffmpegPath);

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

export { ffmpeg };
