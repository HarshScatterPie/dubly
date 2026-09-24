/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { TranscriptSegment } from '../types';
import { projectService } from './projectService';

export interface TranscriptionResult {
  language: string;
  languageCode: string;
  segments: TranscriptSegment[];
  speakersCount: number;
  speakerVoiceMap: Record<string, string>;
  wordsCount: number;
  /** How many segments were dropped as speech-model repetition on non-speech audio. */
  removedSegments: number;
  sanitizeNote: string;
}

export class SpeechToTextService {
  /**
   * Runs real speech-to-text (Gemini on Vertex AI, server-side) on the video already
   * uploaded/imported to `projectId`. Speaker count/voice-map come from a best-effort
   * Gemini diarization pass run server-side right after transcription.
   */
  public async transcribe(projectId: string): Promise<TranscriptionResult> {
    return this.toResult(await projectService.transcribe(projectId));
  }

  /** Follows a transcription that is already running, e.g. one started before the page was reloaded. */
  public async resume(projectId: string, jobId: string): Promise<TranscriptionResult> {
    return this.toResult(await projectService.awaitTranscription(projectId, jobId));
  }

  private toResult(raw: Awaited<ReturnType<typeof projectService.transcribe>>): TranscriptionResult {
    const {
      transcriptSegments,
      wordsCount,
      detectedLanguage,
      sourceLanguageCode,
      speakersCount,
      speakerVoiceMap,
      removedSegments,
      sanitizeNote,
    } = raw;
    return {
      language: detectedLanguage,
      languageCode: sourceLanguageCode,
      segments: transcriptSegments,
      speakersCount,
      speakerVoiceMap,
      wordsCount,
      removedSegments,
      sanitizeNote,
    };
  }
}

export const speechToTextService = new SpeechToTextService();
