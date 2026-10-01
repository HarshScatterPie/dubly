import { createRequire } from 'node:module';
import ffmpeg from 'fluent-ffmpeg';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';

const require = createRequire(import.meta.url);

// ffmpeg/ffprobe binaries: FFMPEG_PATH/FFPROBE_PATH in production (OS package), otherwise the npm-bundled builds.
export const ffmpegPath: string = process.env.FFMPEG_PATH || (require('ffmpeg-static') as string);
export const ffprobePath: string = process.env.FFPROBE_PATH || ffprobeInstaller.path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

export { ffmpeg };
