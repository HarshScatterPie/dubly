/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DubbingProject, LocalizedSegment, TranscriptSegment, TranslationStyle, VoiceEmotion } from '../types';
import { apiDelete, apiGet, apiPatch, apiPost, apiUpload } from '../lib/apiClient';
import { randomId } from '../lib/randomId';

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

  // Samples are named by id; the server looks up the URL itself and fetches nothing else.
  public importSample(projectId: string, sampleId: string): Promise<DubbingProject> {
    return apiPost<DubbingProject>(`/api/projects/${projectId}/import-sample`, { sampleId });
  }

  public getJob(projectId: string, jobId: string): Promise<JobView> {
    return apiGet<JobView>(`/api/projects/${projectId}/jobs/${encodeURIComponent(jobId)}`);
  }

  public cancelJob(projectId: string, jobId: string): Promise<JobView> {
    return apiPost<JobView>(`/api/projects/${projectId}/jobs/${encodeURIComponent(jobId)}/cancel`);
  }

  /** Polls a job until it settles. A few failed polls in a row (a network blip) are tolerated before giving up. */
  private async waitForJob(projectId: string, jobId: string): Promise<JobView> {
    let failures = 0;
    for (;;) {
      try {
        const job = await this.getJob(projectId, jobId);
        failures = 0;
        if (job.settled) return job;
      } catch (err) {
        if (++failures >= 5) throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
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
    // Runs as a background job on the server; this waits for it by polling instead of holding one request open for minutes.
    const { jobId } = await apiPost<{ jobId: string }>(`/api/projects/${projectId}/transcribe`, undefined, { Prefer: 'respond-async' });
    return this.awaitTranscription(projectId, jobId);
  }

  /** Waits for a transcription job that is already running (one started before a page reload, say) and returns its result. */
  public async awaitTranscription(projectId: string, jobId: string): Promise<Awaited<ReturnType<ProjectService['transcribe']>>> {
    const job = await this.waitForJob(projectId, jobId);
    if (job.status !== 'completed') throw new Error(job.message || 'Analysis failed. Please try again.');
    const project = await this.get(projectId);
    const result = { ...project, ...(job.result as { detectedLanguage: string; removedSegments?: number; sanitizeNote?: string }) };
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

  /** Creates a public watch link for one language's dub that stops working after 24 hours. */
  public async createShareLink(projectId: string, languageCode: string): Promise<{ url: string; expiresAt: string; shareId: string }> {
    const res = await apiPost<{ path: string; expiresAt: string; shareId: string }>(`/api/projects/${projectId}/share`, { languageCode });
    return { url: `${window.location.origin}${res.path}`, expiresAt: res.expiresAt, shareId: res.shareId };
  }

  /** Turns a share link off before it expires; its video stops playing within two hours at most. */
  public revokeShareLink(projectId: string, shareId: string): Promise<void> {
    return apiDelete(`/api/projects/${projectId}/shares/${encodeURIComponent(shareId)}`);
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
  ): Promise<{ status: string; jobId?: string }> {
    // One key per start: if this request is retried the server hands back the same job instead of starting (and charging) a second one.
    return apiPost<{ status: string; jobId?: string }>(`/api/projects/${projectId}/dub`, opts, { 'Idempotency-Key': randomId() });
  }

  /** Re-renders one language with its edited lines, charged only for the lines that changed since its last render. */
  public retakeLines(projectId: string, languageCode: string): Promise<{ status: string; jobId: string; changedLines: number; minutes: number }> {
    return apiPost(`/api/projects/${projectId}/languages/${languageCode}/retake`, undefined, { 'Idempotency-Key': randomId() });
  }
}

/** A server job (dub or transcription) as the API reports it. */
export interface JobView {
  id: string;
  type: 'dub' | 'transcribe';
  status: 'queued' | 'running' | 'completed' | 'partially_completed' | 'failed' | 'cancelled';
  settled: boolean;
  progress: number;
  message: string | null;
  errorCode: string | null;
  result: Record<string, unknown> | null;
}

export const projectService = new ProjectService();
