import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { clearRateLimits, hit, rateLimit } from './rateLimit';
import { Semaphore, SemaphoreTimeoutError } from './semaphore';
import { enqueueDub, freezeQueue, positionInQueue, queueStats, resetQueueForTests } from './dubQueue';
import { limits, rateRules } from './limits';
import { createUser, db, resetEmulators, startApi, type TestApi } from '../test/helpers';
import { getJob, reconcileStaleJobs, startDubJob, STALE_AFTER_MS, type DubJob } from './jobs';
import { QUEUED_MESSAGE, setDubPipelineForTests, type PipelineResult } from '../routes/dub';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('rate limiter', () => {
  beforeEach(() => clearRateLimits());

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

describe('dub admission queue', () => {
  beforeEach(() => resetQueueForTests());
  afterEach(() => resetQueueForTests());

  function gatedEntry(jobId: string, workspaceId: string) {
    let finish!: () => void;
    const started = { value: false };
    const entry = {
      jobId,
      workspaceId,
      start: () =>
        new Promise<void>((r) => {
          started.value = true;
          finish = r;
        }),
      abandon: () => undefined,
    };
    return { entry, started, finish: () => finish() };
  }

  it(`runs at most ${limits.maxDubsPerWorkspace} per workspace and queues the rest in order`, async () => {
    const a = gatedEntry('a', 'ws-1');
    const b = gatedEntry('b', 'ws-1');
    const c = gatedEntry('c', 'ws-1');
    const d = gatedEntry('d', 'ws-1');
    expect(enqueueDub(a.entry).startedImmediately).toBe(true);
    expect(enqueueDub(b.entry).startedImmediately).toBe(true);
    expect(enqueueDub(c.entry).startedImmediately).toBe(false);
    expect(enqueueDub(d.entry).startedImmediately).toBe(false);
    expect(positionInQueue('c')).toBe(0);
    expect(positionInQueue('d')).toBe(1);

    // Another workspace is not held up by this one's queue.
    const other = gatedEntry('x', 'ws-2');
    expect(enqueueDub(other.entry).startedImmediately).toBe(true);

    a.finish();
    await tick();
    await tick();
    expect(c.started.value).toBe(true);
    expect(d.started.value).toBe(false);
    expect(queueStats()).toEqual({ running: 3, waiting: 1 });
  });

  it(`never runs more than ${limits.maxActiveDubs} in total`, async () => {
    const entries = Array.from({ length: limits.maxActiveDubs + 1 }, (_, i) => gatedEntry(`j${i}`, `ws-${i}`));
    const started = entries.map((e) => enqueueDub(e.entry).startedImmediately);
    expect(started.filter(Boolean)).toHaveLength(limits.maxActiveDubs);
    entries[0].finish();
    await tick();
    await tick();
    expect(entries[limits.maxActiveDubs].started.value).toBe(true);
  });

  it('releases waiting jobs untouched when frozen for shutdown', () => {
    const abandoned: string[] = [];
    for (const id of ['a', 'b', 'c']) enqueueDub({ ...gatedEntry(id, 'ws-1').entry, abandon: () => abandoned.push(id) });
    expect(freezeQueue()).toBe(1);
    expect(abandoned).toEqual(['c']);
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
      await db.collection('workspaces').doc(workspaceId).collection('projects').doc(projectId).set({
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
    const third = await db.collection('workspaces').doc(workspaceId).collection('projects').doc(ids[2]).get();
    expect(third.get('status')).toBe('processing');
    expect(third.get('currentProcessingMessage')).toBe(QUEUED_MESSAGE);

    gates.get(ids[0])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
    await waitUntil(async () => (await job(2))?.status === 'running');
    gates.get(ids[1])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
    gates.get(ids[2])!({ completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed' } });
    await waitUntil(async () => Boolean((await job(2))?.settled));
  });

  it('puts a job that was still waiting when its process died back in the queue instead of failing it', async () => {
    const { user, workspaceId, ids } = await seed(1);
    const { job } = await startDubJob({ workspaceId, projectId: ids[0], userId: user.uid, languages: ['hi'], minutes: 1 });
    await db.collection('jobs').doc(job.id).update({ heartbeatAt: new Date(Date.now() - STALE_AFTER_MS - 1000).toISOString() });

    const requeued: DubJob[] = [];
    expect(await reconcileStaleJobs(new Set(), Date.now(), (j) => requeued.push(j))).toEqual([]);
    expect(requeued.map((j) => j.id)).toEqual([job.id]);
    const after = await getJob(job.id);
    expect(after?.settled).toBe(false);
    expect(after?.status).toBe('queued');
    // Claimed with a fresh heartbeat, so a second reconciliation pass leaves it alone.
    expect(await reconcileStaleJobs(new Set(), Date.now(), (j) => requeued.push(j))).toEqual([]);
    expect(requeued).toHaveLength(1);
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
