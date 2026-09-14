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
   * Runs real speech-to-text (Sarvam saaras / OpenAI Whisper, routed server-side) on the
   * video already uploaded/imported to `projectId`. Speaker count/voice-map come from a
   * best-effort Gemini diarization pass run server-side right after transcription.
   */
  public async transcribe(projectId: string): Promise<TranscriptionResult> {
    const {
      transcriptSegments,
      wordsCount,
      detectedLanguage,
      sourceLanguageCode,
      speakersCount,
      speakerVoiceMap,
      removedSegments,
      sanitizeNote,
    } = await projectService.transcribe(projectId);
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
