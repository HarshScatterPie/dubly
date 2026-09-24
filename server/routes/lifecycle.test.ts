import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, db, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';
import { bucket } from '../lib/firebaseAdmin';
import { shareIdFor } from './share';
import { sweepExpiredRecords } from '../lib/recordSweeper';
import { limits } from '../lib/limits';
import { invalidateStorageUsage } from '../lib/storageUsage';
import { costEstimate, createCostMeter, recordStt, recordTts } from '../lib/costMeter';

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

async function put(path: string, bytes = 1024) {
  await bucket.file(path).save(Buffer.alloc(bytes, 1), { resumable: false, contentType: 'video/mp4' });
}
const exists = async (path: string) => (await bucket.file(path).exists())[0];

// A finished Hindi dub with its source, render, a captioned render and a thumbnail in the project's own folder.
async function finishedProject(user: TestUser) {
  const workspaceId = (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;
  const projectId = `proj-${Math.random().toString(36).slice(2)}`;
  const base = `workspaces/${workspaceId}/projects/${projectId}`;
  await Promise.all([put(`${base}/source.mp4`, 4096), put(`${base}/dubbed_hi.mp4`, 2048), put(`${base}/dubbed_captioned_hi.mp4`, 2048), put(`${base}/thumbnail.jpg`, 512)]);
  await db.collection('workspaces').doc(workspaceId).collection('projects').doc(projectId).set({
    id: projectId,
    ownerUid: user.uid,
    title: 'Done',
    targetLanguage: 'hi',
    targetLanguages: ['hi'],
    videoStoragePath: `${base}/source.mp4`,
    videoThumbnailStoragePath: `${base}/thumbnail.jpg`,
    finalDubbedVideoStoragePath: `${base}/dubbed_hi.mp4`,
    languageOutputs: { hi: { languageCode: 'hi', status: 'completed', progressPercent: 100, finalDubbedVideoStoragePath: `${base}/dubbed_hi.mp4` } },
    status: 'completed',
    videoDuration: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return { workspaceId, projectId, base };
}

describe('share links', () => {
  it('stores only a hash of the token, and a link can be turned off', async () => {
    const user = await createUser('sharer@team.test');
    const { projectId } = await finishedProject(user);
    const created = await api.call('POST', `/api/projects/${projectId}/share`, { token: user.token, body: { languageCode: 'hi' } });
    expect(created.status).toBe(201);
    expect(created.body.shareId).toBe(shareIdFor(created.body.token));
    expect((await db.collection('shares').doc(created.body.token).get()).exists).toBe(false);
    expect((await db.collection('shares').doc(created.body.shareId).get()).exists).toBe(true);

    const page = await fetch(`${api.baseUrl}${created.body.path}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect((await api.call('GET', `/api/projects/${projectId}/shares`, { token: user.token })).body.shares).toHaveLength(1);

    expect((await api.call('DELETE', `/api/projects/${projectId}/shares/${created.body.shareId}`, { token: user.token })).status).toBe(204);
    expect((await fetch(`${api.baseUrl}${created.body.path}`)).status).toBe(410);
    expect((await api.call('GET', `/api/projects/${projectId}/shares`, { token: user.token })).body.shares).toHaveLength(0);
  });

  it('does not let another workspace see or turn off a link', async () => {
    const owner = await createUser('owner@team.test');
    const other = await createUser('other@team.test');
    const { projectId } = await finishedProject(owner);
    await api.call('GET', '/api/workspace', { token: other.token });
    const created = await api.call('POST', `/api/projects/${projectId}/share`, { token: owner.token, body: { languageCode: 'hi' } });
    expect((await api.call('DELETE', `/api/projects/${projectId}/shares/${created.body.shareId}`, { token: other.token })).status).toBe(404);
    expect((await api.call('GET', `/api/projects/${projectId}/shares`, { token: other.token })).body.shares).toHaveLength(0);
    expect((await fetch(`${api.baseUrl}${created.body.path}`)).status).toBe(200);
  });

  it('keeps links made before tokens were hashed working until they expire', async () => {
    const user = await createUser('legacy-share@team.test');
    const { projectId, base } = await finishedProject(user);
    await db.collection('shares').doc('legacyRawToken123456').set({
      uid: user.uid,
      projectId,
      languageCode: 'hi',
      storagePath: `${base}/dubbed_hi.mp4`,
      title: 'Done',
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect((await fetch(`${api.baseUrl}/api/share/legacyRawToken123456`)).status).toBe(200);
  });
});

describe('deleting a project', () => {
  it('removes every file in its folder (captioned renders included) and its share links, but never another project’s files', async () => {
    const user = await createUser('deleter@team.test');
    const { projectId, base, workspaceId } = await finishedProject(user);
    // A path inherited from a copy of another workspace's project: still used there, so it must survive.
    const foreign = 'workspaces/ws-someone-else/projects/proj-original/source.mp4';
    await put(foreign);
    await db.collection('workspaces').doc(workspaceId).collection('projects').doc(projectId).update({ dubbedAudioStoragePath: foreign });
    const share = await api.call('POST', `/api/projects/${projectId}/share`, { token: user.token, body: { languageCode: 'hi' } });

    expect((await api.call('DELETE', `/api/projects/${projectId}`, { token: user.token })).status).toBe(204);
    for (const file of ['source.mp4', 'dubbed_hi.mp4', 'dubbed_captioned_hi.mp4', 'thumbnail.jpg']) expect(await exists(`${base}/${file}`)).toBe(false);
    expect(await exists(foreign)).toBe(true);
    expect((await db.collection('shares').doc(share.body.shareId).get()).exists).toBe(false);
  });
});

describe('usage accounting', () => {
  it('reports storage measured from the bucket, and it goes down after a delete', async () => {
    const user = await createUser('storage@team.test');
    const { projectId, workspaceId } = await finishedProject(user);
    const before = (await api.call('GET', '/api/usage', { token: user.token })).body;
    expect(before.storageUsedMb).toBeCloseTo((4096 + 2048 + 2048 + 512) / (1024 * 1024), 1);
    expect(before.storageLimitMb).toBe(limits.storageLimitMb);
    await api.call('DELETE', `/api/projects/${projectId}`, { token: user.token });
    invalidateStorageUsage(workspaceId);
    expect((await api.call('GET', '/api/usage', { token: user.token })).body.storageUsedMb).toBe(0);
  });

  it('refuses an upload past the storage allowance only when enforcement is on', async () => {
    const user = await createUser('full@team.test');
    await finishedProject(user);
    const project = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'More' } });
    const upload = async () => {
      const form = new FormData();
      form.append('file', new Blob([Buffer.alloc(2048)], { type: 'video/mp4' }), 'x.mp4');
      const res = await fetch(`${api.baseUrl}/api/projects/${project.body.id}/upload`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` }, body: form });
      return { status: res.status, body: await res.json() };
    };
    const saved = { ...limits };
    try {
      limits.storageLimitMb = 0.001;
      // Off (the default): the upload proceeds to content validation, which rejects this non-video.
      expect((await upload()).body.error.code).toBe('UNSUPPORTED_MEDIA');
      limits.enforceStorageLimit = true;
      const refused = await upload();
      expect(refused.status).toBe(413);
      expect(refused.body.error.code).toBe('STORAGE_LIMIT_REACHED');
    } finally {
      Object.assign(limits, saved);
    }
  });

  it('refuses to dub a video whose length is unknown (it would cost nothing)', async () => {
    const user = await createUser('zero@team.test');
    const { projectId } = await finishedProject(user);
    const res = await api.call('POST', `/api/projects/${projectId}/dub`, { token: user.token, body: {} });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VIDEO_DURATION_UNKNOWN');
  });

  it('turns metered provider usage into a stored estimate', () => {
    const meter = createCostMeter();
    recordTts(meter, 'vertex', 1_000_000, false);
    recordTts(meter, 'vertex', 500, true);
    recordStt(meter, 'vertex', 60);
    const estimate = costEstimate(meter);
    expect(estimate).toMatchObject({ ttsChars: 1_000_000, ttsCharsFromCache: 500, sttSeconds: 60 });
    expect(estimate.estimatedInr).toBeGreaterThan(0);
  });
});

describe('record retention', () => {
  it('deletes expired shares, invitations, idempotency keys and old jobs, and nothing current', async () => {
    const day = 24 * 3600_000;
    const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
    await Promise.all([
      db.collection('shares').doc('old').set({ expiresAt: iso(8 * day) }),
      db.collection('shares').doc('recent').set({ expiresAt: iso(1 * day) }),
      db.collection('invites').doc('old').set({ expiresAt: iso(31 * day) }),
      db.collection('invites').doc('recent').set({ expiresAt: iso(-day) }),
      db.collection('jobIdempotency').doc('old').set({ createdAt: iso(3 * day) }),
      db.collection('jobIdempotency').doc('recent').set({ createdAt: iso(0) }),
      db.collection('jobs').doc('old').set({ finishedAt: iso(181 * day) }),
      db.collection('jobs').doc('running').set({ finishedAt: null }),
    ]);
    const deleted = await sweepExpiredRecords();
    expect(deleted).toEqual({ shares: 1, invites: 1, jobIdempotency: 1, jobs: 1 });
    for (const [col, doc] of [['shares', 'recent'], ['invites', 'recent'], ['jobIdempotency', 'recent'], ['jobs', 'running']]) {
      expect((await db.collection(col).doc(doc).get()).exists).toBe(true);
    }
  });
});
