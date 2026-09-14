/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Voice, VoiceEmotion } from '../types';
import { apiPost } from '../lib/apiClient';
import { audioPlayer } from './audioPlayer';
import { VOICES } from '../data/mockData';

export interface TTSOptions {
  voiceId: string;
  speed?: number;
  pitch?: number;
  emotion?: VoiceEmotion;
  languageCode?: string;
}

export interface TTSResult {
  audioUrl: string;
  durationSeconds: number;
  waveformPeaks: number[];
  provider: string;
}

interface GenerateResponse {
  provider: string;
  audioUrl: string;
  durationSeconds: number;
}

async function computeWaveformPeaks(dataUri: string, sampleCount = 64): Promise<number[]> {
  try {
    const res = await fetch(dataUri);
    const arrayBuffer = await res.arrayBuffer();
    const AudioContextClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioContextClass();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const channel = audioBuffer.getChannelData(0);
    const blockSize = Math.max(1, Math.floor(channel.length / sampleCount));
    const peaks: number[] = [];
    for (let i = 0; i < sampleCount; i++) {
      let sum = 0;
      const start = i * blockSize;
      for (let j = 0; j < blockSize && start + j < channel.length; j++) {
        sum += Math.abs(channel[start + j]);
      }
      peaks.push(Math.min(1, (sum / blockSize) * 3.5));
    }
    ctx.close();
    return peaks;
  } catch {
    return new Array(sampleCount).fill(0.3);
  }
}

export class TextToSpeechService {
  /**
   * Generates natural speech audio via Sarvam Bulbul / Google (Vertex Gemini) / OpenAI TTS,
   * routed server-side by language + user provider preference.
   */
  public async generateSpeech(text: string, options: TTSOptions): Promise<TTSResult> {
    const { audioUrl, durationSeconds, provider } = await apiPost<GenerateResponse>('/api/tts/generate', {
      text,
      voiceId: options.voiceId,
      languageCode: options.languageCode,
      speed: options.speed,
      pitch: options.pitch,
    });
    const waveformPeaks = await computeWaveformPeaks(audioUrl);
    return { audioUrl, durationSeconds, waveformPeaks, provider };
  }

  /** Speaks arbitrary text with a given voice/language and plays it immediately. */
  public async speakText(
    text: string,
    voice: Voice,
    languageCode?: string,
    opts: { onStart?: () => void; onEnd?: () => void; onError?: (err: Error) => void } = {}
  ): Promise<void> {
    try {
      const { audioUrl } = await apiPost<GenerateResponse>('/api/tts/generate', {
        text,
        voiceId: voice.id,
        languageCode: languageCode || voice.languageCode,
      });
      audioPlayer.play(audioUrl, opts);
    } catch (err) {
      opts.onEnd?.();
      opts.onError?.(err as Error);
    }
  }

  public async playVoicePreview(voice: Voice, customText?: string): Promise<void> {
    return this.speakText(customText || voice.sampleQuote, voice, voice.languageCode);
  }

  public stopPlayback(): void {
    audioPlayer.stop();
  }

  public getVoiceById(id: string): Voice | undefined {
    return VOICES.find((v) => v.id === id);
  }
}

export const textToSpeechService = new TextToSpeechService();
