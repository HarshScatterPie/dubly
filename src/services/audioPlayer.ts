/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Plays real synthesized audio (data URIs / storage URLs) through a single shared
// <audio> element.

class AudioPlayer {
  private el: HTMLAudioElement | null = null;

  private getElement(): HTMLAudioElement {
    if (!this.el) {
      this.el = new Audio();
    }
    return this.el;
  }

  public play(url: string, opts: { onStart?: () => void; onEnd?: () => void } = {}): void {
    this.stop();
    const el = this.getElement();
    el.src = url;
    el.onplay = () => opts.onStart?.();
    el.onended = () => opts.onEnd?.();
    el.onerror = () => opts.onEnd?.();
    void el.play().catch(() => opts.onEnd?.());
  }

  public stop(): void {
    if (this.el) {
      this.el.pause();
      this.el.currentTime = 0;
      this.el.onended = null;
      this.el.onerror = null;
    }
  }

  public isPlaying(): boolean {
    return Boolean(this.el && !this.el.paused && !this.el.ended);
  }
}

export const audioPlayer = new AudioPlayer();
