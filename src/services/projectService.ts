/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { DubbingProject, FaceScan, LocalizedSegment, SpeakerProfile, TranscriptSegment, TranslationStyle, VoiceEmotion } from '../types';
import { ApiError, apiDelete, apiGet, apiPatch, apiPost, apiPutBytes, apiUpload } from '../lib/apiClient';
import { randomId } from '../lib/randomId';

export class ProjectService {
  public createDraft(title: string, sourceLanguage = 'en', targetLanguage = 'hi'): Promise<DubbingProject> {
    return apiPost<DubbingProject>('/api/projects', { title, sourceLanguage, targetLanguage });
  }

  public list(): Promise<DubbingProject[]> {
    return apiGet<DubbingProject[]>('/api/projects');
  }

  // Two screens (or a double click) asking at once share one request: a whole project is the largest thing the API sends.
  private reading = new Map<string, Promise<DubbingProject>>();

  public get(projectId: string): Promise<DubbingProject> {
    const running = this.reading.get(projectId);
    if (running) return running;
    const request = apiGet<DubbingProject>(`/api/projects/${projectId}`).finally(() => this.reading.delete(projectId));
    this.reading.set(projectId, request);
    return request;
  }

  /** Status, percentage and message only: what a progress bar polls, instead of the whole project (transcript, every language, signed URLs). */
  public patch(projectId: string, patch: Partial<DubbingProject>): Promise<DubbingProject> {
    return apiPatch<DubbingProject>(`/api/projects/${projectId}`, patch);
  }

  public delete(projectId: string): Promise<void> {
    return apiDelete(`/api/projects/${projectId}`);
  }

  /** One request for a small file; a large one goes in chunks, so no request is too big for the front door and a dropped connection costs one chunk. */
  public async uploadVideo(projectId: string, file: File): Promise<DubbingProject> {
    if (file.size <= SINGLE_REQUEST_UPLOAD_BYTES) return apiUpload<DubbingProject>(`/api/projects/${projectId}/upload`, file);

    const base = `/api/projects/${projectId}/uploads`;
    const { uploadId, chunkBytes } = await apiPost<{ uploadId: string; chunkBytes: number }>(base, { fileName: file.name, size: file.size, contentType: file.type });
    const count = Math.ceil(file.size / chunkBytes);
    let next = 0;
    const sendChunks = async () => {
      while (next < count) {
        const index = next++;
        const chunk = file.slice(index * chunkBytes, (index + 1) * chunkBytes);
        for (let attempt = 1; ; attempt++) {
          try {
            await apiPutBytes(`${base}/${uploadId}/chunks/${index}`, chunk);
            break;
          } catch (err) {
            if (attempt >= CHUNK_ATTEMPTS) throw err;
            await pause(1000 * attempt);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_CHUNKS }, sendChunks));
    return apiPost<DubbingProject>(`${base}/${uploadId}/complete`);
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

  /**
   * Asks over and over until `done`: each request waits on the server until there is something new, so this costs a few requests a
   * minute however long the work runs. A few failures in a row (a network blip, a restart) are tolerated before giving up;
   * `signal` stops following, while the work itself carries on.
   */
  private async follow<T extends { revision?: string }>(path: string, done: (value: T) => boolean, onUpdate: (value: T) => void, signal?: AbortSignal): Promise<T> {
    let since = '';
    let failures = 0;
    for (;;) {
      signal?.throwIfAborted();
      try {
        const value = await apiGet<T>(since ? `${path}?since=${since}` : path, signal);
        failures = 0;
        since = value.revision ?? '';
        onUpdate(value);
        if (done(value)) return value;
        // A server from before long polling answers at once, so the pause is here.
        if (!value.revision) await pause(1500);
      } catch (err) {
        signal?.throwIfAborted();
        if (++failures >= 5) throw err;
        await pause(1500 * failures);
      }
    }
  }

  /** Follows a job until it settles. */
  private waitForJob(projectId: string, jobId: string, signal?: AbortSignal, onUpdate: (job: JobView) => void = () => undefined): Promise<JobView> {
    return this.follow<JobView>(`/api/projects/${projectId}/jobs/${encodeURIComponent(jobId)}`, (job) => job.settled, onUpdate, signal);
  }

  /** Follows a project's dub until it has completed or failed, reporting each change along the way. */
  public followProgress(projectId: string, onUpdate: (progress: ProjectProgress) => void, signal?: AbortSignal): Promise<ProjectProgress> {
    return this.follow<ProjectProgress>(`/api/projects/${projectId}/progress`, (p) => p.status === 'completed' || p.status === 'failed', onUpdate, signal);
  }

  public async transcribe(
    projectId: string,
    signal?: AbortSignal,
    onUpdate?: (job: JobView) => void
  ): Promise<{
    transcriptSegments: TranscriptSegment[];
    wordsCount: number;
    detectedLanguage: string;
    sourceLanguageCode: string;
    speakersCount: number;
    speakerVoiceMap: Record<string, string>;
    speakerProfiles: Record<string, SpeakerProfile>;
    removedSegments: number;
    sanitizeNote: string;
    missingParts: { start: number; end: number }[];
  }> {
    // Runs as a background job on the server; this waits for it by polling instead of holding one request open for minutes.
    const { jobId } = await apiPost<{ jobId: string }>(`/api/projects/${projectId}/transcribe`, undefined, { Prefer: 'respond-async' });
    return this.awaitTranscription(projectId, jobId, signal, onUpdate);
  }

  /** Waits for a transcription job that is already running (one started before a page reload, say) and returns its result. */
  public async awaitTranscription(
    projectId: string,
    jobId: string,
    signal?: AbortSignal,
    onUpdate?: (job: JobView) => void
  ): Promise<Awaited<ReturnType<ProjectService['transcribe']>>> {
    const job = await this.waitForJob(projectId, jobId, signal, onUpdate);
    if (job.status !== 'completed') throw new Error(job.message || 'Analysis failed. Please try again.');
    const project = await this.get(projectId);
    const result = {
      ...project,
      ...(job.result as { detectedLanguage: string; removedSegments?: number; sanitizeNote?: string; missingParts?: { start: number; end: number }[] }),
    };
    return {
      sourceLanguageCode: result.sourceLanguage,
      transcriptSegments: result.transcriptSegments,
      wordsCount: result.wordsCount,
      detectedLanguage: result.detectedLanguage,
      speakersCount: result.speakersCount,
      speakerVoiceMap: result.speakerVoiceMap || {},
      speakerProfiles: result.speakerProfiles || {},
      removedSegments: result.removedSegments || 0,
      sanitizeNote: result.sanitizeNote || '',
      missingParts: result.missingParts || [],
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

  /**
   * Resolves the right download URL for one language's dub — plain (instant) or with karaoke
   * captions burned in. A captioned render re-encodes the whole video, so the server does it
   * in the background (once per language, then cached) and this waits for it by polling.
   */
  public async exportVideo(
    projectId: string,
    captions: boolean,
    languageCode?: string,
    onWaiting?: (seconds: number) => void
  ): Promise<{ url: string }> {
    const first = await apiPost<{ url?: string; status?: string }>(`/api/projects/${projectId}/export-video`, { captions, languageCode });
    if (first.url) return { url: first.url };
    const started = Date.now();
    let failures = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      onWaiting?.(Math.round((Date.now() - started) / 1000));
      const query = languageCode ? `?languageCode=${encodeURIComponent(languageCode)}` : '';
      let state: { status: string; url?: string; error?: string };
      try {
        state = await apiGet(`/api/projects/${projectId}/export-video/captions${query}`);
        failures = 0;
      } catch (err) {
        // A dropped connection or a gateway hiccup is retried; an answer from the server is final.
        const transient = !(err instanceof ApiError) || err.status >= 502;
        if (!transient || ++failures >= 5) throw err;
        continue;
      }
      if (state.status === 'ready' && state.url) return { url: state.url };
      if (state.status === 'failed') throw new Error(state.error || 'Adding captions failed. Please try again.');
    }
  }

  /** Faces on screen in the project's video (scanned on upload; scans older projects on first ask). */
  public scanFaces(projectId: string): Promise<{ faceScan: FaceScan | null; available: boolean }> {
    return apiPost(`/api/projects/${projectId}/face-scan`, {});
  }

  /** Creates a public watch link for one language's dub that stops working after 24 hours. */
  public async createShareLink(
    projectId: string,
    languageCode: string,
    captions = true
  ): Promise<{ url: string; expiresAt: string; shareId: string; captions: boolean }> {
    const res = await apiPost<{ path: string; expiresAt: string; shareId: string; captions?: boolean }>(`/api/projects/${projectId}/share`, {
      languageCode,
      captions,
    });
    return { url: `${window.location.origin}${res.path}`, expiresAt: res.expiresAt, shareId: res.shareId, captions: res.captions !== false };
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

export type ProjectProgress = Pick<DubbingProject, 'status' | 'progressPercent' | 'currentProcessingMessage' | 'updatedAt'> & { revision?: string };

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
  /** What the project shows the user while the job runs. */
  progressPercent?: number;
  progressMessage?: string | null;
  /** Sent back to wait for the next change. */
  revision?: string;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Above this a file goes in chunks. Two at a time keep the connection busy while one is being stored.
const SINGLE_REQUEST_UPLOAD_BYTES = 64 * 1024 * 1024;
const PARALLEL_CHUNKS = 2;
const CHUNK_ATTEMPTS = 4;

export const projectService = new ProjectService();
