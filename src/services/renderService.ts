/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { LocalizedSegment } from '../types';
import { toSrt, toVtt } from '../lib/captionCues';

export class RenderService {
  /**
   * SRT subtitles, timed to where the dubbed voice speaks each line and split into
   * readable two-line cues — the same cues the player and the burned-in export show.
   */
  public generateSRT(segments: LocalizedSegment[]): string {
    return toSrt(segments.filter((s) => s.translatedText.trim()));
  }

  /** WebVTT subtitles, same cues as the SRT. */
  public generateVTT(segments: LocalizedSegment[]): string {
    return toVtt(
      segments.filter((s) => s.translatedText.trim()),
      'Dubly Localized Subtitles'
    );
  }

  /**
   * Triggers client-side browser file download
   */
  public downloadTextFile(filename: string, content: string, mimeType = 'text/plain') {
    // A BOM so editors on Windows open Hindi, Tamil and other scripts as UTF-8 instead of mojibake.
    const blob = new Blob(['﻿', content], { type: `${mimeType};charset=utf-8` });
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

  /** A filename-safe version of a project title, keeping letters of any script. */
  public safeName(title: string): string {
    return title.replace(/[^\p{L}\p{N}]+/gu, '_').replace(/^_+|_+$/g, '') || 'Dub';
  }
}

export const renderService = new RenderService();
