import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, db, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';
import { setTranscriptionPipelineForTests, type TranscriptionOutcome } from './projects';
import { setDubPipelineForTests, type PipelineResult } from './dub';
import { getJob, reconcileStaleJobs, requestCancel, STALE_AFTER_MS, writeProjectForJob, type DubJob } from '../lib/jobs';
import { HttpError } from '../lib/httpError';
import { currentUsagePeriod } from '../lib/projectRepo';

let api: TestApi;
beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  await resetEmulators();
});
afterEach(() => {
  setTranscriptionPipelineForTests(null);
  setDubPipelineForTests(null);
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

async function until<T>(read: () => Promise<T>, ok: (v: T) => boolean): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const v = await read();
    if (ok(v)) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}

interface Fx {
  user: TestUser;
  workspaceId: string;
  projectId: string;
}

async function seed(): Promise<Fx> {
  const user = await createUser('jobs@team.test');
  const workspaceId = (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;
  const projectId = `proj-jobs-${Math.random().toString(36).slice(2)}`;
  await db.collection('workspaces').doc(workspaceId).collection('projects').doc(projectId).set({
    id: projectId,
    ownerUid: user.uid,
    title: 'Jobs',
    videoStoragePath: `workspaces/${workspaceId}/projects/${projectId}/source.mp4`,
    videoDuration: 120,
    targetLanguage: 'hi',
    targetLanguages: ['hi', 'ta'],
    localizedSegments: [{ id: 'l1', segmentId: 's1', startTime: 0, endTime: 1, sourceText: 'a', translatedText: 'b', isEdited: false }],
    languageOutputs: {
      hi: { languageCode: 'hi', status: 'draft', progressPercent: 0, localizedSegments: [{ id: 'l1', segmentId: 's1', startTime: 0, endTime: 1, sourceText: 'a', translatedText: 'b', isEdited: false }] },
      ta: { languageCode: 'ta', status: 'draft', progressPercent: 0, localizedSegments: [{ id: 'l2', segmentId: 's1', startTime: 0, endTime: 1, sourceText: 'a', translatedText: 'c', isEdited: false }] },
    },
    transcriptSegments: [{ id: 's1', startTime: 0, endTime: 1, text: 'a', speaker: 'Speaker 1', wordsCount: 1 }],
    selectedVoiceId: 'google-hi-charon',
    voiceSpeed: 1,
    voicePitch: 1,
    status: 'draft',
    currentStep: 'upload',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { user, workspaceId, projectId };
}

const projectDoc = (f: Fx) => db.collection('workspaces').doc(f.workspaceId).collection('projects').doc(f.projectId);
const transcribe = (f: Fx, async = true) =>
  api.call('POST', `/api/projects/${f.projectId}/transcribe`, { token: f.user.token, headers: async ? { Prefer: 'respond-async' } : {} });
const jobView = (f: Fx, jobId: string) => api.call('GET', `/api/projects/${f.projectId}/jobs/${jobId}`, { token: f.user.token });
const settled = (f: Fx, jobId: string) => until(() => jobView(f, jobId), (r) => r.body.settled === true).then((r) => r.body);

const analysis = (text = 'hello world'): TranscriptionOutcome => ({
  projectPatch: {
    transcriptSegments: [{ id: 'seg-1', startTime: 0, endTime: 1, text, speaker: 'Speaker 1', wordsCount: 2, confidence: 0.9 }],
    sourceLanguage: 'en',
    wordsCount: 2,
    speakersCount: 1,
    currentStep: 'understand',
    progressPercent: 0,
    currentProcessingMessage: '',
  },
  result: { detectedLanguage: 'English', removedSegments: 3, sanitizeNote: 'Removed 3 repeated lines' },
});

describe('asynchronous transcription', () => {
  it('answers 202 with a job, and the job completes with the transcript saved', async () => {
    const f = await seed();
    setTranscriptionPipelineForTests(async () => analysis());
    const res = await transcribe(f);
    expect(res.status).toBe(202);
    const job = await settled(f, res.body.jobId);
    expect(job).toMatchObject({ type: 'transcribe', status: 'completed', result: { detectedLanguage: 'English', removedSegments: 3 } });
    const project = (await api.call('GET', `/api/projects/${f.projectId}`, { token: f.user.token })).body;
    expect(project.transcriptSegments[0].text).toBe('hello world');
    expect(project.currentStep).toBe('understand');
    expect(project.activeJobId).toBeUndefined();
  });

  it('still answers synchronously for clients that do not ask for async', async () => {
    const f = await seed();
    setTranscriptionPipelineForTests(async () => analysis('sync'));
    const res = await transcribe(f, false);
    expect(res.status).toBe(200);
    expect(res.body.transcriptSegments[0].text).toBe('sync');
    expect(res.body.detectedLanguage).toBe('English');
    expect(res.body.removedSegments).toBe(3);
  });

  it('holds the project: a dub or a second analysis during an analysis gets 409', async () => {
    const f = await seed();
    const gate = deferred<TranscriptionOutcome>();
    setTranscriptionPipelineForTests(() => gate.promise);
    const first = await transcribe(f);
    const second = await transcribe(f);
    expect(second.status).toBe(409);
    const dub = await api.call('POST', `/api/projects/${f.projectId}/dub`, { token: f.user.token, body: {} });
    expect(dub.status).toBe(409);
    expect(dub.body.error.message).toMatch(/analyzed/);
    gate.resolve(analysis());
    await settled(f, first.body.jobId);
  });

  it('reports a failure with a safe message, never the internal error', async () => {
    const f = await seed();
    setTranscriptionPipelineForTests(async () => {
      throw new Error('PERMISSION_DENIED: projects/gen-x/locations/global/publishers/google/models/gemini');
    });
    const job = await settled(f, (await transcribe(f)).body.jobId);
    expect(job.status).toBe('failed');
    expect(job.errorCode).toBe('ANALYSIS_FAILED');
    expect(job.message).toBe('Analysis failed. Please try again.');
    expect(JSON.stringify(job)).not.toContain('PERMISSION_DENIED');
    expect((await projectDoc(f).get()).get('status')).toBe('draft');

    setTranscriptionPipelineForTests(async () => {
      throw new HttpError(503, 'SERVER_BUSY', 'Dubly is busy processing other videos right now.');
    });
    const busy = await settled(f, (await transcribe(f)).body.jobId);
    expect(busy).toMatchObject({ status: 'failed', errorCode: 'SERVER_BUSY', message: 'Dubly is busy processing other videos right now.' });
  });

  it('can be cancelled, and stops at its next step', async () => {
    const f = await seed();
    const reached = deferred<void>();
    const proceed = deferred<void>();
    setTranscriptionPipelineForTests(async (job) => {
      reached.resolve();
      await proceed.promise;
      await writeProjectForJob(job, { progressPercent: 50, currentProcessingMessage: 'halfway' });
      return analysis('should never be saved');
    });
    const { jobId } = (await transcribe(f)).body;
    await reached.promise;
    const cancel = await api.call('POST', `/api/projects/${f.projectId}/jobs/${jobId}/cancel`, { token: f.user.token });
    expect(cancel.status).toBe(202);
    proceed.resolve();
    const job = await settled(f, jobId);
    expect(job).toMatchObject({ status: 'cancelled', errorCode: 'CANCELLED' });
    const project = (await projectDoc(f).get()).data()!;
    expect(project.activeJobId).toBeUndefined();
    expect(project.currentProcessingMessage).toBe('');
    // The project is free again.
    setTranscriptionPipelineForTests(async () => analysis());
    expect((await transcribe(f)).status).toBe(202);
  });

  it('is stopped by its timeout', async () => {
    const f = await seed();
    const proceed = deferred<void>();
    setTranscriptionPipelineForTests(async (job) => {
      await proceed.promise;
      await writeProjectForJob(job, { progressPercent: 50 });
      return analysis();
    });
    const { jobId } = (await transcribe(f)).body;
    await requestCancel(jobId, 'timeout');
    proceed.resolve();
    expect(await settled(f, jobId)).toMatchObject({ status: 'cancelled', errorCode: 'TIMEOUT' });
  });

  it('is failed cleanly after a crash, without marking the project failed', async () => {
    const f = await seed();
    setTranscriptionPipelineForTests(() => new Promise(() => undefined));
    const { jobId } = (await transcribe(f)).body;
    await db.collection('jobs').doc(jobId).update({ heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString() });
    expect(await reconcileStaleJobs(new Set())).toEqual([jobId]);
    expect((await getJob(jobId))?.errorCode).toBe('INTERRUPTED');
    const project = (await projectDoc(f).get()).data()!;
    expect(project.status).toBe('draft');
    expect(project.activeJobId).toBeUndefined();
  });

  it('hides another workspace’s jobs', async () => {
    const f = await seed();
    setTranscriptionPipelineForTests(async () => analysis());
    const { jobId } = (await transcribe(f)).body;
    const stranger = await createUser('stranger@team.test');
    await api.call('GET', '/api/workspace', { token: stranger.token });
    expect((await api.call('GET', `/api/projects/${f.projectId}/jobs/${jobId}`, { token: stranger.token })).status).toBe(404);
    expect((await api.call('POST', `/api/projects/${f.projectId}/jobs/${jobId}/cancel`, { token: stranger.token })).status).toBe(404);
  });
});

describe('cancelling dubs', () => {
  const minutesUsed = async (f: Fx) => ((await db.collection('workspaces').doc(f.workspaceId).collection('meta').doc('usage').get()).get('minutesDubbed') as number) ?? 0;

  it('refunds only the languages that had not finished', async () => {
    const f = await seed();
    const proceed = deferred<void>();
    setDubPipelineForTests(async (job: DubJob): Promise<PipelineResult> => {
      // Hindi renders, then the run reaches its next step after the cancel.
      await writeProjectForJob(job, {}, { completedLanguages: ['hi'] });
      await proceed.promise;
      await writeProjectForJob(job, { progressPercent: 60 });
      return { completed: ['hi', 'ta'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } };
    });
    const { jobId } = (await api.call('POST', `/api/projects/${f.projectId}/dub`, { token: f.user.token, body: {} })).body;
    await until(() => getJob(jobId), (j) => (j?.completedLanguages?.length ?? 0) === 1);
    await api.call('POST', `/api/projects/${f.projectId}/jobs/${jobId}/cancel`, { token: f.user.token });
    proceed.resolve();
    const job = await settled(f, jobId);
    expect(job).toMatchObject({ status: 'cancelled', minutesReserved: 4, minutesRefunded: 2 });
    expect(await minutesUsed(f)).toBe(2);
  });

  it('cancels a queued dub on the spot with a full refund, and it never starts', async () => {
    const f = await seed();
    await db.collection('workspaces').doc(f.workspaceId).collection('meta').doc('usage').set({ minutesDubbed: 0, usagePeriod: currentUsagePeriod() }, { merge: true });
    // Two other projects in the workspace fill its two dub slots.
    const gate = deferred<PipelineResult>();
    let runs = 0;
    setDubPipelineForTests(() => {
      runs++;
      return gate.promise;
    });
    const others = await Promise.all([seed2(f), seed2(f)]);
    for (const id of others) await api.call('POST', `/api/projects/${id}/dub`, { token: f.user.token, body: {} });
    const { jobId } = (await api.call('POST', `/api/projects/${f.projectId}/dub`, { token: f.user.token, body: {} })).body;
    await until(() => getJob(jobId), (j) => j?.status === 'queued');

    const cancelled = await api.call('POST', `/api/projects/${f.projectId}/jobs/${jobId}/cancel`, { token: f.user.token });
    expect(cancelled.body).toMatchObject({ status: 'cancelled', settled: true, minutesRefunded: 4 });
    gate.resolve({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
    await new Promise((r) => setTimeout(r, 500));
    expect(runs).toBe(2);
  });
});

// Another dubbable project in the same workspace.
async function seed2(f: Fx): Promise<string> {
  const id = `proj-other-${Math.random().toString(36).slice(2)}`;
  const base = (await projectDoc(f).get()).data()!;
  await db.collection('workspaces').doc(f.workspaceId).collection('projects').doc(id).set({ ...base, id, targetLanguages: ['hi'] });
  return id;
}
