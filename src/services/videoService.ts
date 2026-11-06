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
  previewUrl: string;
}

export class VideoService {
  /**
   * What is known about a picked video before it is uploaded: its name, size and a local preview. Its length and picture size
   * come from the server, which measures the file itself as part of the upload (ffprobe), so nothing here guesses them and the
   * upload never waits on the browser decoding the file first.
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
      // A blob: URL for this file only; the studio revokes it when the preview changes or closes.
      previewUrl: URL.createObjectURL(file),
    };
  }

  public formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

export const videoService = new VideoService();
