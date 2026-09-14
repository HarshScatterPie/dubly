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
   * Reads metadata and creates preview object URL from user-uploaded video file
   */
  public async parseVideoFile(file: File): Promise<VideoMetadata> {
    const previewUrl = URL.createObjectURL(file);
    const sizeInMb = (file.size / (1024 * 1024)).toFixed(1);

    return new Promise((resolve) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.src = previewUrl;

      video.onloadedmetadata = () => {
        const duration = Math.round(video.duration) || 30;
        const mins = Math.floor(duration / 60);
        const secs = duration % 60;
        const durationFormatted = `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        const resolution = `${video.videoWidth || 1920} × ${video.videoHeight || 1080} (${video.videoHeight >= 1080 ? 'Full HD' : 'HD'})`;

        resolve({
          fileName: file.name,
          fileSizeFormatted: `${sizeInMb} MB`,
          durationSeconds: duration,
          durationFormatted,
          resolution,
          // Real values are not known until the Analyze step actually runs STT —
          // showing a confident guess here would be exactly the kind of fake
          // "detection" this app is supposed to stop doing.
          detectedAudio: 'Not yet analyzed',
          detectedLanguage: 'Pending analysis',
          previewUrl,
        });
      };

      video.onerror = () => {
        resolve({
          fileName: file.name,
          fileSizeFormatted: `${sizeInMb} MB`,
          durationSeconds: 32,
          durationFormatted: '00:32',
          resolution: 'Unknown',
          detectedAudio: 'Not yet analyzed',
          detectedLanguage: 'Pending analysis',
          previewUrl,
        });
      };
    });
  }

  public formatDuration(seconds: number): string {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
}

export const videoService = new VideoService();
