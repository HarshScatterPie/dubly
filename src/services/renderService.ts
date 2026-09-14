/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalizedSegment } from '../types';

export class RenderService {
  /**
   * Generates SRT subtitle file content
   */
  public generateSRT(segments: LocalizedSegment[]): string {
    return segments
      .map((seg, index) => {
        const start = this.formatSRTTimestamp(seg.startTime);
        const end = this.formatSRTTimestamp(seg.endTime);
        return `${index + 1}\n${start} --> ${end}\n${seg.translatedText}\n`;
      })
      .join('\n');
  }

  /**
   * Generates VTT subtitle file content
   */
  public generateVTT(segments: LocalizedSegment[]): string {
    const body = segments
      .map((seg) => {
        const start = this.formatVTTTimestamp(seg.startTime);
        const end = this.formatVTTTimestamp(seg.endTime);
        return `${start} --> ${end}\n${seg.translatedText}\n`;
      })
      .join('\n');
    return `WEBVTT - Dubly Localized Subtitles\n\n${body}`;
  }

  private formatSRTTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')},${ms.toString().padStart(3, '0')}`;
  }

  private formatVTTTimestamp(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 1000);
    return `${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  /**
   * Triggers client-side browser file download
   */
  public downloadTextFile(filename: string, content: string, mimeType = 'text/plain') {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Downloads a real media file. Fetches it into a blob first — Firebase Storage signed
   * URLs are cross-origin, and a plain `<a download>` pointed at a cross-origin URL is
   * ignored by most browsers (they navigate instead of downloading), so we force it via
   * a same-origin blob: URL.
   */
  public async downloadMedia(filename: string, mediaUrl: string): Promise<void> {
    if (!mediaUrl) throw new Error('This export is not ready yet.');
    const res = await fetch(mediaUrl);
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  }
}

export const renderService = new RenderService();
