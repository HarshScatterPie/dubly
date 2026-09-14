/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DubbingProject, LocalizedSegment, TranscriptSegment, TranslationStyle, VoiceEmotion } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload } from '../lib/apiClient';

export class ProjectService {
  public createDraft(title: string, sourceLanguage = 'en', targetLanguage = 'hi'): Promise<DubbingProject> {
    return apiPost<DubbingProject>('/api/projects', { title, sourceLanguage, targetLanguage });
  }

  public list(): Promise<DubbingProject[]> {
    return apiGet<DubbingProject[]>('/api/projects');
  }

  public get(projectId: string): Promise<DubbingProject> {
    return apiGet<DubbingProject>(`/api/projects/${projectId}`);
  }

  public patch(projectId: string, patch: Partial<DubbingProject>): Promise<DubbingProject> {
    return apiPatch<DubbingProject>(`/api/projects/${projectId}`, patch);
  }

  public delete(projectId: string): Promise<void> {
    return apiDelete(`/api/projects/${projectId}`);
  }

  public uploadVideo(projectId: string, file: File): Promise<DubbingProject> {
    return apiUpload<DubbingProject>(`/api/projects/${projectId}/upload`, file);
  }

  public importSample(projectId: string, sourceUrl: string, fileName: string): Promise<DubbingProject> {
    return apiPost<DubbingProject>(`/api/projects/${projectId}/import-sample`, { sourceUrl, fileName });
  }

  public async transcribe(
    projectId: string
  ): Promise<{
    transcriptSegments: TranscriptSegment[];
    wordsCount: number;
    detectedLanguage: string;
    sourceLanguageCode: string;
    speakersCount: number;
    speakerVoiceMap: Record<string, string>;
    removedSegments: number;
    sanitizeNote: string;
  }> {
    const result = await apiPost<
      DubbingProject & { detectedLanguage: string; removedSegments?: number; sanitizeNote?: string }
    >(`/api/projects/${projectId}/transcribe`);
    return {
      sourceLanguageCode: result.sourceLanguage,
      transcriptSegments: result.transcriptSegments,
      wordsCount: result.wordsCount,
      detectedLanguage: result.detectedLanguage,
      speakersCount: result.speakersCount,
      speakerVoiceMap: result.speakerVoiceMap || {},
      removedSegments: result.removedSegments || 0,
      sanitizeNote: result.sanitizeNote || '',
    };
  }

  /**
   * Translates the transcript into every selected language in one call (the server runs
   * them in parallel). Returns the whole project, since the result is now one translation
   * per language rather than a single list of segments.
   */
  public translate(
    projectId: string,
    targetLanguageCodes: string[],
    style: TranslationStyle,
    adaptExpressions: boolean,
    /** Re-translate languages that already have a translation, instead of reusing them. */
    regenerate = false
  ): Promise<DubbingProject> {
    return apiPost<DubbingProject>(`/api/projects/${projectId}/translate`, {
      targetLanguageCodes,
      style,
      adaptExpressions,
      regenerate,
    });
  }

  /** Saves hand-edited translations for one language. */
  public updateLanguageSegments(
    projectId: string,
    languageCode: string,
    localizedSegments: LocalizedSegment[]
  ): Promise<DubbingProject> {
    return apiPatch<DubbingProject>(`/api/projects/${projectId}/languages/${languageCode}/segments`, {
      localizedSegments,
    });
  }

  /** Resolves the right download URL for one language's dub — plain (fast) or with karaoke captions burned in (rendered once per language, then cached server-side). */
  public exportVideo(projectId: string, captions: boolean, languageCode?: string): Promise<{ url: string }> {
    return apiPost<{ url: string }>(`/api/projects/${projectId}/export-video`, { captions, languageCode });
  }

  public startDub(
    projectId: string,
    opts: {
      voiceId: string;
      voiceSpeed: number;
      voicePitch: number;
      voiceEmotion: VoiceEmotion;
      speakerVoiceMap?: Record<string, string>;
      /** Language code -> voice id, so each target language can have its own voice. */
      languageVoiceMap?: Record<string, string>;
      /** Language code -> speaker label -> voice id, for a multi-speaker video dubbed into several languages. */
      languageSpeakerVoiceMap?: Record<string, Record<string, string>>;
      autoLipSync?: boolean;
      separateBackground?: boolean;
      /** Render only these languages. Omit to render every language the project targets. */
      languages?: string[];
    }
  ): Promise<{ status: string }> {
    return apiPost<{ status: string }>(`/api/projects/${projectId}/dub`, opts);
  }
}

export const projectService = new ProjectService();
