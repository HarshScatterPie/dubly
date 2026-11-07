/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface VideoMetadata {
  fileName: string;
  fileSizeFormatted: string;
  durationSeconds: number;
  durationFormatted: string;
  resolution: string;
  detectedAudio: string;
  detectedLanguage: string;
}

// The server's own limit; the checks here only save a wait, the server repeats every one of them on the content itself.
const MAX_VIDEO_BYTES = 500 * 1024 * 1024;

export class VideoService {
  /** Why a picked file cannot be uploaded, or null when it can. */
  public problemWith(file: File): string | null {
    if (!file.type.startsWith('video/') && !/\.(mp4|mov|webm)$/i.test(file.name)) return 'Choose a video file (MP4, MOV or WebM).';
    if (file.size === 0) return 'That file is empty.';
    if (file.size > MAX_VIDEO_BYTES) return 'That file is over the 500 MB limit. Use a shorter or smaller video.';
    return null;
  }

  /**
   * What is known about a picked video before it is uploaded: its name and size. Its length and picture size come from the
   * server, which measures the file itself as part of the upload (ffprobe), so nothing here guesses them and the upload never
   * waits on the browser decoding the file first. The preview is the stored copy (a signed URL), so what plays is what Dubly has.
   */
  public describeLocalFile(file: File): VideoMetadata {
    return {
      fileName: file.name,
      fileSizeFormatted: `${(file.size / (1024 * 1024)).toFixed(1)} MB`,
      durationSeconds: 0,
      durationFormatted: '--:--',
      resolution: 'Measuring…',
      detectedAudio: 'Not yet analyzed',
      detectedLanguage: 'Pending analysis',
    };
  }

  public formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

export const videoService = new VideoService();
