import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createUser, db, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';
import { runDubJob, setDubPipelineForTests, type PipelineResult } from './dub';
import {
  getJob,
  jobDirFor,
  JobSupersededError,
  reconcileStaleJobs,
  settleJob,
  startDubJob,
  STALE_AFTER_MS,
  writeProjectForJob,
  type DubJob,
} from '../lib/jobs';
import { startDraining } from '../lib/lifecycle';
import { currentUsagePeriod } from '../lib/projectRepo';
import { clearPlanCaches, setWorkspacePlan } from '../lib/plans';

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
  setDubPipelineForTests(null);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface Fixture {
  user: TestUser;
  workspaceId: string;
  projectId: string;
}

// A translated two-language, two-minute project: each full dub reserves 4 minutes.
async function seedProject(): Promise<Fixture> {
  const user = await createUser('dubber@team.test');
  const ws = await api.call('GET', '/api/workspace', { token: user.token });
  const workspaceId = ws.body.id as string;
  const projectId = `proj-test-${Math.random().toString(36).slice(2)}`;
  const seg = (lang: string) => ({
    id: `loc-${lang}-seg-1`,
    segmentId: 'seg-1',
    startTime: 0,
    endTime: 2,
    speaker: 'Speaker 1',
    sourceText: 'hello',
    translatedText: `hello in ${lang}`,
    isEdited: false,
  });
  const now = new Date().toISOString();
  await db.collection('workspaces').doc(workspaceId).collection('projects').doc(projectId).set({
    id: projectId,
    ownerUid: user.uid,
    title: 'Fixture',
    videoStoragePath: `workspaces/${workspaceId}/projects/${projectId}/source.mp4`,
    videoDuration: 120,
    videoFileName: 'fixture.mp4',
    videoResolution: '',
    videoFileSize: '1.0 MB',
    sourceLanguage: 'en',
    targetLanguage: 'hi',
    targetLanguages: ['hi', 'ta'],
    localizedSegments: [seg('hi')],
    languageOutputs: {
      hi: { languageCode: 'hi', localizedSegments: [seg('hi')], status: 'draft', progressPercent: 0 },
      ta: { languageCode: 'ta', localizedSegments: [seg('ta')], status: 'draft', progressPercent: 0 },
    },
    transcriptSegments: [{ id: 'seg-1', startTime: 0, endTime: 2, text: 'hello', speaker: 'Speaker 1', wordsCount: 1 }],
    selectedVoiceId: 'google-hi-charon',
    languageVoiceMap: {},
    languageSpeakerVoiceMap: {},
    translationStyle: 'natural',
    adaptExpressions: true,
    autoLipSync: false,
    voiceSpeed: 1,
    voicePitch: 1,
    voiceEmotion: 'friendly',
    status: 'draft',
    currentStep: 'voice',
    progressPercent: 0,
    createdAt: now,
    updatedAt: now,
    wordsCount: 1,
    speakersCount: 1,
  });
  return { user, workspaceId, projectId };
}

const projectDoc = (f: Fixture) => db.collection('workspaces').doc(f.workspaceId).collection('projects').doc(f.projectId);
const minutesUsed = async (f: Fixture) =>
  ((await db.collection('workspaces').doc(f.workspaceId).collection('meta').doc('usage').get()).get('minutesDubbed') as number) ?? 0;
const startDub = (f: Fixture, headers: Record<string, string> = {}, body: unknown = {}) =>
  api.call('POST', `/api/projects/${f.projectId}/dub`, { token: f.user.token, body, headers });
const settledJob = (jobId: string) => waitFor(() => getJob(jobId), (j) => Boolean(j?.settled));

const success = (completed: string[]): PipelineResult => ({
  completed,
  wordsCount: 1,
  fileSizeMb: 1,
  projectPatch: { status: 'completed', progressPercent: 100, currentStep: 'export' },
});

describe('dub jobs: one run per project', () => {
  it('turns a double click into one job and one charge', async () => {
    const f = await seedProject();
    const gate = deferred<PipelineResult>();
    let runs = 0;
    setDubPipelineForTests(() => {
      runs++;
      return gate.promise;
    });

    const [a, b] = await Promise.all([startDub(f), startDub(f)]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    const conflict = a.status === 409 ? a : b;
    expect(conflict.body.error.code).toBe('JOB_ALREADY_RUNNING');
    expect(await minutesUsed(f)).toBe(4);

    gate.resolve(success(['hi', 'ta']));
    const accepted = a.status === 202 ? a : b;
    const job = await settledJob(accepted.body.jobId);
    expect(job?.status).toBe('completed');
    expect(runs).toBe(1);
    expect(await minutesUsed(f)).toBe(4);
    const project = (await projectDoc(f).get()).data()!;
    expect(project.status).toBe('completed');
    expect(project.activeJobId).toBeUndefined();
  });

  it('returns the same job for a repeated Idempotency-Key and never reserves twice', async () => {
    const f = await seedProject();
    const gate = deferred<PipelineResult>();
    let runs = 0;
    setDubPipelineForTests(() => {
      runs++;
      return gate.promise;
    });

    const first = await startDub(f, { 'Idempotency-Key': 'click-1' });
    const again = await startDub(f, { 'Idempotency-Key': 'click-1' });
    expect(first.status).toBe(202);
    expect(again.status).toBe(202);
    expect(again.body.jobId).toBe(first.body.jobId);

    const other = await startDub(f, { 'Idempotency-Key': 'click-2' });
    expect(other.status).toBe(409);
    expect(await minutesUsed(f)).toBe(4);

    gate.resolve(success(['hi', 'ta']));
    await settledJob(first.body.jobId);
    // Replaying the key after completion still names the finished job instead of starting another.
    const late = await startDub(f, { 'Idempotency-Key': 'click-1' });
    expect(late.body.jobId).toBe(first.body.jobId);
    expect(runs).toBe(1);
    expect(await minutesUsed(f)).toBe(4);
  });

  it('refunds everything when the pipeline fails, and a retry runs as a new attempt', async () => {
    const f = await seedProject();
    setDubPipelineForTests(async () => {
      throw new Error('TTS provider unavailable');
    });
    const failed = await startDub(f);
    const failedJob = await settledJob(failed.body.jobId);
    expect(failedJob?.status).toBe('failed');
    expect(failedJob?.errorCode).toBe('DUB_FAILED');
    expect(failedJob?.minutesRefunded).toBe(4);
    expect(await minutesUsed(f)).toBe(0);
    const afterFailure = (await projectDoc(f).get()).data()!;
    expect(afterFailure.status).toBe('failed');
    expect(afterFailure.activeJobId).toBeUndefined();

    setDubPipelineForTests(async () => success(['hi', 'ta']));
    const retry = await startDub(f);
    expect(retry.status).toBe(202);
    const retryJob = await settledJob(retry.body.jobId);
    expect(retryJob?.status).toBe('completed');
    expect(retryJob?.attemptCount).toBe(2);
    expect(await minutesUsed(f)).toBe(4);
  });

  it('bills only the languages that rendered when some fail', async () => {
    const f = await seedProject();
    setDubPipelineForTests(async () => success(['hi']));
    const res = await startDub(f);
    const job = await settledJob(res.body.jobId);
    expect(job?.status).toBe('partially_completed');
    expect(job?.completedLanguages).toEqual(['hi']);
    expect(job?.failedLanguages).toEqual(['ta']);
    expect(job?.minutesRefunded).toBe(2);
    expect(await minutesUsed(f)).toBe(2);
  });

  it('refuses a dub the monthly allowance cannot cover, without creating a job', async () => {
    const f = await seedProject();
    await db.collection('workspaces').doc(f.workspaceId).collection('meta').doc('usage').set({ minutesDubbed: 118, usagePeriod: currentUsagePeriod() }, { merge: true });
    const res = await startDub(f);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('QUOTA_EXCEEDED');
    expect((await db.collection('jobs').get()).size).toBe(0);
    expect((await projectDoc(f).get()).get('status')).toBe('draft');
  });

  it('refuses new dubs while the server is draining for a restart', async () => {
    const f = await seedProject();
    startDraining();
    const res = await startDub(f);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('SERVER_RESTARTING');
    expect(await minutesUsed(f)).toBe(0);
  });
});

describe('dub jobs: crash recovery', () => {
  // A job whose process died: created and charged, never heartbeating again.
  async function orphanedJob(f: Fixture): Promise<DubJob> {
    const { job } = await startDubJob({ workspaceId: f.workspaceId, projectId: f.projectId, userId: f.user.uid, languages: ['hi', 'ta'], minutes: 4 });
    await db.collection('jobs').doc(job.id).update({ heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString() });
    return job;
  }

  it('settles a stale job on reconciliation: failed, fully refunded, scratch removed, project released', async () => {
    const f = await seedProject();
    const job = await orphanedJob(f);
    await mkdir(jobDirFor(job.id), { recursive: true });
    await writeFile(path.join(jobDirFor(job.id), 'source.mp4'), 'partial render');
    expect(await minutesUsed(f)).toBe(4);

    expect(await reconcileStaleJobs()).toEqual([job.id]);
    const settled = await getJob(job.id);
    expect(settled?.status).toBe('failed');
    expect(settled?.errorCode).toBe('INTERRUPTED');
    expect(settled?.minutesRefunded).toBe(4);
    expect(await minutesUsed(f)).toBe(0);
    await expect(stat(jobDirFor(job.id))).rejects.toThrow();
    const project = (await projectDoc(f).get()).data()!;
    expect(project.status).toBe('failed');
    expect(project.activeJobId).toBeUndefined();

    // Running reconciliation again (next tick, another restart) changes nothing.
    expect(await reconcileStaleJobs()).toEqual([]);
    expect(await minutesUsed(f)).toBe(0);
  });

  it('leaves live jobs alone: fresh heartbeats and jobs running in this process', async () => {
    const f = await seedProject();
    const { job } = await startDubJob({ workspaceId: f.workspaceId, projectId: f.projectId, userId: f.user.uid, languages: ['hi'], minutes: 2 });
    expect(await reconcileStaleJobs()).toEqual([]);
    const later = Date.now() + STALE_AFTER_MS + 5000;
    expect(await reconcileStaleJobs(new Set([job.id]), later)).toEqual([]);
    expect((await getJob(job.id))?.settled).toBe(false);
  });

  it('lets a new dub take over from a stale job, refunding the dead one exactly once', async () => {
    const f = await seedProject();
    const dead = await orphanedJob(f);
    setDubPipelineForTests(async () => success(['hi', 'ta']));

    const res = await startDub(f);
    expect(res.status).toBe(202);
    expect(res.body.jobId).not.toBe(dead.id);
    expect((await getJob(dead.id))?.errorCode).toBe('INTERRUPTED');
    await settledJob(res.body.jobId);
    expect(await minutesUsed(f)).toBe(4);
  });

  it('never refunds twice, even when settlement is attempted repeatedly or concurrently', async () => {
    const f = await seedProject();
    const { job } = await startDubJob({ workspaceId: f.workspaceId, projectId: f.projectId, userId: f.user.uid, languages: ['hi', 'ta'], minutes: 4 });
    const outcome = { status: 'failed' as const, refundMinutes: 4, errorCode: 'X' };
    const results = await Promise.all([settleJob(job.id, outcome), settleJob(job.id, outcome), settleJob(job.id, outcome)]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await settleJob(job.id, outcome)).toBe(false);
    expect(await minutesUsed(f)).toBe(0);
    expect((await getJob(job.id))?.minutesRefunded).toBe(4);
  });

  it('stops a run that lost ownership from writing to the project', async () => {
    const f = await seedProject();
    const zombieGate = deferred<void>();
    setDubPipelineForTests(async (job) => {
      await zombieGate.promise;
      await writeProjectForJob(job, { currentProcessingMessage: 'zombie write' });
      return success(['hi', 'ta']);
    });
    const res = await startDub(f);
    const jobId = res.body.jobId as string;

    // The run is declared dead (e.g. its heartbeat stalled) and settled while it is actually still going.
    await db.collection('jobs').doc(jobId).update({ heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString() });
    expect(await reconcileStaleJobs()).toEqual([jobId]);
    zombieGate.resolve();

    await new Promise((r) => setTimeout(r, 500));
    const project = (await projectDoc(f).get()).data()!;
    expect(project.currentProcessingMessage).not.toBe('zombie write');
    expect(project.status).toBe('failed');
    const job = await getJob(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.errorCode).toBe('INTERRUPTED');
    expect(await minutesUsed(f)).toBe(0);
  });

  it('rejects guarded writes from a job that no longer owns the project', async () => {
    const f = await seedProject();
    const { job } = await startDubJob({ workspaceId: f.workspaceId, projectId: f.projectId, userId: f.user.uid, languages: ['hi'], minutes: 2 });
    await settleJob(job.id, { status: 'cancelled', refundMinutes: 2 });
    await expect(writeProjectForJob(job, { progressPercent: 50 })).rejects.toBeInstanceOf(JobSupersededError);
    await runDubJob(job, async () => success(['hi']));
    expect((await getJob(job.id))?.status).toBe('cancelled');
  });
});

describe('plans and paid extras', () => {
  const turnOnExtras = (f: Fixture) =>
    api.call('PUT', '/api/settings', { token: f.user.token, body: { preferences: { aiReview: true, premiumVoices: true } } });

  it('charges an Enterprise dub faster for the extras switched on, records them on the job, and refunds at the same rate', async () => {
    const f = await seedProject();
    await setWorkspacePlan(f.workspaceId, 'enterprise');
    expect((await turnOnExtras(f)).status).toBe(200);
    setDubPipelineForTests(async () => success(['hi']));

    const res = await startDub(f);
    expect(res.status).toBe(202);
    const job = await settledJob(res.body.jobId);
    // 2 languages x 2 minutes x (1 + 0.25 AI review + 0.5 premium voices).
    expect(job?.minutesReserved).toBe(7);
    expect(job?.extras).toEqual({ aiReview: true, premiumVoices: true, paceRetakes: false });
    // Tamil failed, so its share of the higher charge comes back.
    expect(job?.minutesRefunded).toBe(3.5);
    expect(await minutesUsed(f)).toBe(3.5);
  });

  it('never charges a Starter workspace for extras, and never runs them', async () => {
    const f = await seedProject();
    expect((await turnOnExtras(f)).status).toBe(200);
    setDubPipelineForTests(async () => success(['hi', 'ta']));

    const res = await startDub(f);
    const job = await settledJob(res.body.jobId);
    expect(job?.minutesReserved).toBe(4);
    expect(job?.extras).toEqual({ aiReview: false, premiumVoices: false, paceRetakes: false });
  });

  it('holds a workspace to its plan’s monthly limit, and says when extras are why a dub does not fit', async () => {
    const f = await seedProject();
    const usage = async () => (await api.call('GET', '/api/usage', { token: f.user.token })).body;
    expect(await usage()).toMatchObject({ activePlan: 'Starter', planId: 'starter', minutesLimit: 50, paidExtrasAllowed: false, teamInvites: false });

    await setWorkspacePlan(f.workspaceId, 'enterprise');
    expect(await usage()).toMatchObject({ activePlan: 'Enterprise', minutesLimit: 120, paidExtrasAllowed: true, teamInvites: true });

    await db.collection('workspaces').doc(f.workspaceId).collection('meta').doc('usage').set({ minutesDubbed: 115, usagePeriod: currentUsagePeriod() }, { merge: true });
    await turnOnExtras(f);
    const refused = await startDub(f);
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(refused.body.error.message).toContain('each dubbed minute uses 1.75 min');
  });

  it('keeps plans in the database, where an operator’s change wins over the built-in values', async () => {
    const f = await seedProject();
    await api.call('GET', '/api/usage', { token: f.user.token });
    expect((await db.collection('dublyPlans').doc('starter').get()).get('minutesPerMonth')).toBe(50);

    await db.collection('dublyPlans').doc('starter').set({ minutesPerMonth: 30, name: 'Starter Lite' }, { merge: true });
    clearPlanCaches();
    const usage = (await api.call('GET', '/api/usage', { token: f.user.token })).body;
    expect(usage).toMatchObject({ activePlan: 'Starter Lite', minutesLimit: 30 });
  });
});
