import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { clearRateLimits, forget, hit, hitShared, rateLimit, retryAfter } from './rateLimit';
import { Semaphore, SemaphoreTimeoutError } from './semaphore';
import { freezeQueue } from './dubQueue';
import { limits, rateRules } from './limits';
import { createUser, patchJob, readProject, resetEmulators, seedProject, startApi, type TestApi } from '../test/helpers';
import { claimNextDubJob, getJob, JobConflictError, reconcileStaleJobs, startDubJob, STALE_AFTER_MS } from './jobs';
import { mongoDb } from './mongo';
import { QUEUED_MESSAGE, setDubPipelineForTests, type PipelineResult } from '../routes/dub';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('rate limiter', () => {
  beforeEach(async () => {
    clearRateLimits();
    await resetEmulators();
  });

  it('allows up to the limit in a window, then reports the wait', () => {
    const rule = { max: 2, windowMs: 1000 };
    expect(hit('k', rule, 0)).toBe(0);
    expect(hit('k', rule, 10)).toBe(0);
    expect(hit('k', rule, 20)).toBe(1);
    expect(hit('k', rule, 1000)).toBe(0);
    expect(hit('other', rule, 20)).toBe(0);
  });

  it('answers 429 with Retry-After, and a refused request does not use up the other rules', async () => {
    const app = express();
    const tight = { max: 1, windowMs: 60_000 };
    const loose = { max: 5, windowMs: 60_000 };
    app.use((req, _res, next) => {
      req.uid = String(req.headers['x-user']);
      req.workspaceId = 'ws-1';
      next();
    });
    app.get('/x', rateLimit('t', [['user', tight], ['workspace', loose]]), (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      expect((await fetch(`${base}/x`, { headers: { 'x-user': 'a' } })).status).toBe(200);
      const refused = await fetch(`${base}/x`, { headers: { 'x-user': 'a' } });
      expect(refused.status).toBe(429);
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await refused.json()).code).toBe('RATE_LIMITED');
      // Only 1 of the workspace's 5 was used, so four more people can still go.
      for (const user of ['b', 'c', 'd', 'e']) expect((await fetch(`${base}/x`, { headers: { 'x-user': user } })).status).toBe(200);
      expect((await fetch(`${base}/x`, { headers: { 'x-user': 'f' } })).status).toBe(429);
    } finally {
      server.close();
    }
  });

  it('counts a shared limit exactly when many callers arrive at once', async () => {
    const rule = { max: 5, windowMs: 60_000 };
    const waits = await Promise.all(Array.from({ length: 25 }, () => hitShared('burst', rule)));
    expect(waits.filter((wait) => wait === 0)).toHaveLength(5);
    expect(Math.min(...waits.filter((wait) => wait > 0))).toBeGreaterThan(0);
  });

  it('starts a new shared window once the old one has ended', async () => {
    const rule = { max: 1, windowMs: 1000 };
    expect(await hitShared('w', rule, 10_000)).toBe(0);
    expect(await hitShared('w', rule, 10_500)).toBe(1);
    expect(await hitShared('w', rule, 11_000)).toBe(0);
  });

  it('looks at a shared limit without counting, and forgets on request', async () => {
    const rule = { max: 1, windowMs: 60_000 };
    expect(await retryAfter('l', rule)).toBe(0);
    expect(await retryAfter('l', rule)).toBe(0);
    expect(await hitShared('l', rule)).toBe(0);
    expect(await retryAfter('l', rule)).toBeGreaterThan(0);
    await forget('l');
    expect(await retryAfter('l', rule)).toBe(0);
  });
});

describe('semaphore', () => {
  it('admits in arrival order and never exceeds capacity', async () => {
    const sem = new Semaphore(2);
    const order: number[] = [];
    const r1 = await sem.acquire();
    const r2 = await sem.acquire();
    const p3 = sem.acquire().then((r) => (order.push(3), r));
    const p4 = sem.acquire().then((r) => (order.push(4), r));
    await tick();
    expect(order).toEqual([]);
    expect(sem.waiting).toBe(2);
    r1();
    const r3 = await p3;
    expect(sem.inUse).toBe(2);
    r2();
    const r4 = await p4;
    expect(order).toEqual([3, 4]);
    r3();
    r4();
    r4();
    expect(sem.inUse).toBe(0);
  });

  it('gives up after the timeout without taking a slot', async () => {
    const sem = new Semaphore(1);
    const release = await sem.acquire();
    await expect(sem.acquire(20)).rejects.toBeInstanceOf(SemaphoreTimeoutError);
    expect(sem.waiting).toBe(0);
    release();
    expect(sem.inUse).toBe(0);
  });
});

describe('queued dubs end to end', () => {
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
  afterEach(() => setDubPipelineForTests(null));

  async function seed(count: number) {
    const user = await createUser('queue@team.test');
    const workspaceId = (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;
    const ids: string[] = [];
    for (let i = 0; i < count; i++) {
      const projectId = `proj-q-${i}`;
      ids.push(projectId);
      await seedProject(workspaceId, {
        id: projectId,
        ownerUid: user.uid,
        title: `Q${i}`,
        videoStoragePath: `workspaces/${workspaceId}/projects/${projectId}/source.mp4`,
        videoDuration: 60,
        targetLanguage: 'hi',
        targetLanguages: ['hi'],
        localizedSegments: [{ id: 'l1', segmentId: 's1', startTime: 0, endTime: 1, sourceText: 'a', translatedText: 'b', isEdited: false }],
        transcriptSegments: [{ id: 's1', startTime: 0, endTime: 1, text: 'a', speaker: 'Speaker 1', wordsCount: 1 }],
        selectedVoiceId: 'google-hi-charon',
        voiceSpeed: 1,
        voicePitch: 1,
        status: 'draft',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }
    return { user, workspaceId, ids };
  }

  it('queues a third dub in the same workspace and starts it when a slot frees up', async () => {
    const { user, workspaceId, ids } = await seed(3);
    const gates = new Map<string, (r: PipelineResult) => void>();
    setDubPipelineForTests((job) => new Promise((resolve) => gates.set(job.projectId, resolve)));

    const jobIds: string[] = [];
    for (const id of ids) {
      const res = await api.call('POST', `/api/projects/${id}/dub`, { token: user.token, body: {} });
      expect(res.status).toBe(202);
      jobIds.push(res.body.jobId);
    }
    const job = (i: number) => getJob(jobIds[i]);
    const waitUntil = async (check: () => Promise<boolean>) => {
      for (let i = 0; i < 100 && !(await check()); i++) await new Promise((r) => setTimeout(r, 50));
      expect(await check()).toBe(true);
    };
    await waitUntil(async () => (await job(0))?.status === 'running' && (await job(1))?.status === 'running');
    expect((await job(2))?.status).toBe('queued');
    const third = await readProject(workspaceId, ids[2]);
    expect(third?.status).toBe('processing');
    expect(third?.currentProcessingMessage).toBe(QUEUED_MESSAGE);

    gates.get(ids[0])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
    await waitUntil(async () => (await job(2))?.status === 'running');
    gates.get(ids[1])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
    gates.get(ids[2])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
    await waitUntil(async () => Boolean((await job(2))?.settled));
  });

  const queueDub = (workspaceId: string, userId: string, projectId: string) =>
    startDubJob({ workspaceId, projectId, userId, languages: ['hi'], minutes: 1 }).then((started) => started.job);
  const staleHeartbeat = () => new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString();

  it('keeps a waiting dub however long it waits, for any process with room to take', async () => {
    const { user, workspaceId, ids } = await seed(1);
    const job = await queueDub(workspaceId, user.uid, ids[0]);
    await patchJob(job.id, { heartbeatAt: staleHeartbeat() });

    expect(await reconcileStaleJobs()).toEqual([]);
    expect((await getJob(job.id))?.status).toBe('queued');

    expect((await claimNextDubJob(2))?.id).toBe(job.id);
    expect((await getJob(job.id))?.status).toBe('running');
    expect(await claimNextDubJob(2)).toBeNull();
  });

  it('holds the workspace cap when several processes admit at the same moment', async () => {
    const { user, workspaceId, ids } = await seed(6);
    for (const id of ids) await queueDub(workspaceId, user.uid, id);

    const claims = await Promise.all(ids.map(() => claimNextDubJob(2)));

    const started = claims.filter((job) => job !== null);
    expect(started).toHaveLength(2);
    expect(new Set(started.map((job) => job.id)).size).toBe(2);
    expect(await mongoDb().collection('jobs').countDocuments({ workspaceId, status: 'running' })).toBe(2);
  });

  it('takes the oldest first, skipping a full workspace without holding up another', async () => {
    const busy = await seed(3);
    const first = await queueDub(busy.workspaceId, busy.user.uid, busy.ids[0]);
    await queueDub(busy.workspaceId, busy.user.uid, busy.ids[1]);
    const otherUser = await createUser('other-queue@team.test');
    const otherWorkspace = (await api.call('GET', '/api/workspace', { token: otherUser.token })).body.id as string;
    await seedProject(otherWorkspace, { id: 'proj-other', ownerUid: otherUser.uid, title: 'O', status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } as never);
    const other = await queueDub(otherWorkspace, otherUser.uid, 'proj-other');

    expect((await claimNextDubJob(1))?.id).toBe(first.id);
    expect((await claimNextDubJob(1))?.id).toBe(other.id);
    expect(await claimNextDubJob(1)).toBeNull();
  });

  it('never mistakes a waiting dub for a dead one when a second dub is asked for', async () => {
    const { user, workspaceId, ids } = await seed(1);
    const job = await queueDub(workspaceId, user.uid, ids[0]);
    await patchJob(job.id, { heartbeatAt: staleHeartbeat() });

    await expect(queueDub(workspaceId, user.uid, ids[0])).rejects.toBeInstanceOf(JobConflictError);
    expect((await getJob(job.id))?.settled).toBe(false);
  });

  it('refunds a waiting dub whose project has gone, rather than scanning past it for ever', async () => {
    const { user, workspaceId, ids } = await seed(1);
    const job = await queueDub(workspaceId, user.uid, ids[0]);
    await mongoDb().collection('projects').deleteOne({ _id: ids[0] as never });

    expect(await claimNextDubJob(2)).toBeNull();
    const after = await getJob(job.id);
    expect(after?.settled).toBe(true);
    expect(after?.minutesRefunded).toBe(1);
  });

  it(`runs at most its share of dubs in this process, starting the next when one ends`, async () => {
    const { user, ids } = await seed(2);
    const saved = limits.maxActiveDubs;
    limits.maxActiveDubs = 1;
    const gates = new Map<string, (r: PipelineResult) => void>();
    setDubPipelineForTests((job) => new Promise((resolve) => gates.set(job.projectId, resolve)));
    try {
      const jobIds: string[] = [];
      for (const id of ids) jobIds.push((await api.call('POST', `/api/projects/${id}/dub`, { token: user.token, body: {} })).body.jobId);
      expect((await getJob(jobIds[0]))?.status).toBe('running');
      expect((await getJob(jobIds[1]))?.status).toBe('queued');

      for (let i = 0; i < 100 && !gates.has(ids[0]); i++) await new Promise((r) => setTimeout(r, 20));
      gates.get(ids[0])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
      for (let i = 0; i < 200 && (await getJob(jobIds[1]))?.status !== 'running'; i++) await new Promise((r) => setTimeout(r, 20));
      expect((await getJob(jobIds[1]))?.status).toBe('running');
      for (let i = 0; i < 100 && !gates.has(ids[1]); i++) await new Promise((r) => setTimeout(r, 20));
      gates.get(ids[1])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
      for (let i = 0; i < 200 && !(await getJob(jobIds[1]))?.settled; i++) await new Promise((r) => setTimeout(r, 20));
    } finally {
      limits.maxActiveDubs = saved;
    }
  });

  it('admits nothing once frozen for shutdown; the dub stays waiting for another process', async () => {
    const { user, ids } = await seed(1);
    freezeQueue();
    const res = await api.call('POST', `/api/projects/${ids[0]}/dub`, { token: user.token, body: {} });
    expect(res.status).toBe(202);
    const after = await getJob(res.body.jobId);
    expect(after?.status).toBe('queued');
    expect(after?.settled).toBe(false);
  });

  it('rate-limits transcription per user with a 429', async () => {
    const saved = { ...rateRules.transcribePerUser };
    rateRules.transcribePerUser.max = 2;
    try {
      const user = await createUser('limited@team.test');
      const project = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'x' } });
      const call = () => api.call('POST', `/api/projects/${project.body.id}/transcribe`, { token: user.token });
      expect((await call()).status).toBe(400);
      expect((await call()).status).toBe(400);
      const limited = await call();
      expect(limited.status).toBe(429);
      expect(limited.body.error.retryAfterSeconds).toBeGreaterThan(0);
    } finally {
      Object.assign(rateRules.transcribePerUser, saved);
    }
  });
});
