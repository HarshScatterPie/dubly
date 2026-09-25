import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, db, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';
import { setDubPipelineForTests, type PipelineResult } from './dub';
import { getJob, type DubJob } from '../lib/jobs';
import { currentLineKey } from '../lib/retake';
import { setWorkspacePlan } from '../lib/plans';
import type { StoredProject } from '../lib/projectRepo';
import type { LocalizedSegment } from '../../src/types';

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

async function waitFor<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 10_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
}

const workspaceOf = async (user: TestUser) => (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;

async function addEditor(admin: TestUser, email: string): Promise<TestUser> {
  const editor = await createUser(email);
  await workspaceOf(editor);
  await setWorkspacePlan(await workspaceOf(admin), 'enterprise');
  const invite = await api.call('POST', '/api/workspace/invites', { token: admin.token, body: { email, role: 'editor' } });
  const accepted = await api.call('POST', '/api/invites/accept', { token: editor.token, body: { token: invite.body.token } });
  expect(accepted.status).toBe(200);
  return editor;
}

describe('workspace glossary', () => {
  const entry = { id: 'g1', term: 'ScatterPie', mode: 'keep', spokenAs: 'Scatter Pie', note: '' };

  it('lets admins maintain it and every member read it', async () => {
    const admin = await createUser('admin@glossary.test');
    await workspaceOf(admin);
    const saved = await api.call('PUT', '/api/workspace/glossary', { token: admin.token, body: { entries: [entry] } });
    expect(saved.status).toBe(200);
    // Empty optional fields are not stored.
    expect(saved.body.entries).toEqual([{ id: 'g1', term: 'ScatterPie', mode: 'keep', spokenAs: 'Scatter Pie' }]);

    const editor = await addEditor(admin, 'editor@glossary.test');
    const read = await api.call('GET', '/api/workspace/glossary', { token: editor.token });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ entries: saved.body.entries, canEdit: false });

    const write = await api.call('PUT', '/api/workspace/glossary', { token: editor.token, body: { entries: [] } });
    expect(write.status).toBe(403);
  });

  it('refuses the same term twice, whatever its case', async () => {
    const admin = await createUser('dupes@glossary.test');
    const res = await api.call('PUT', '/api/workspace/glossary', {
      token: admin.token,
      body: { entries: [entry, { ...entry, id: 'g2', term: 'scatterpie' }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
  });
});

interface Fixture {
  user: TestUser;
  workspaceId: string;
  projectId: string;
}

const line = (n: number, text: string): LocalizedSegment => ({
  id: `loc-hi-seg-${n}`,
  segmentId: `seg-${n}`,
  startTime: n * 10,
  endTime: n * 10 + 4,
  speaker: 'Speaker 1',
  sourceText: `Welcome to ScatterPie, part ${n}`,
  translatedText: text,
  isEdited: false,
});

// A two-minute Hindi project rendered with fingerprints (or, with `legacy`, rendered before they existed).
async function seedRenderedProject(opts: { legacy?: boolean } = {}): Promise<Fixture> {
  const user = await createUser(`owner-${Math.random().toString(36).slice(2)}@review.test`);
  const workspaceId = await workspaceOf(user);
  const projectId = `proj-review-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const project = {
    id: projectId,
    ownerUid: user.uid,
    title: 'Review fixture',
    videoStoragePath: `workspaces/${workspaceId}/projects/${projectId}/source.mp4`,
    finalDubbedVideoStoragePath: `workspaces/${workspaceId}/projects/${projectId}/dubbed_hi.mp4`,
    videoDuration: 120,
    videoFileName: 'fixture.mp4',
    videoResolution: '',
    videoFileSize: '1.0 MB',
    sourceLanguage: 'en',
    targetLanguage: 'hi',
    targetLanguages: ['hi'],
    localizedSegments: [line(1, 'ScatterPie में स्वागत है, भाग एक'), line(2, 'ScatterPie में स्वागत है, भाग दो')],
    transcriptSegments: [],
    selectedVoiceId: 'riya',
    languageVoiceMap: {},
    languageSpeakerVoiceMap: {},
    translationStyle: 'natural',
    adaptExpressions: true,
    autoLipSync: false,
    voiceSpeed: 1,
    voicePitch: 1,
    voiceEmotion: 'friendly',
    status: 'completed',
    currentStep: 'export',
    progressPercent: 100,
    createdAt: now,
    updatedAt: now,
    wordsCount: 10,
    speakersCount: 1,
  } as unknown as StoredProject;
  if (!opts.legacy) {
    project.localizedSegments = project.localizedSegments.map((s) => ({ ...s, renderKey: currentLineKey(project, 'hi', s) }));
  }
  await db.collection('workspaces').doc(workspaceId).collection('projects').doc(projectId).set(project);
  return { user, workspaceId, projectId };
}

const getProject = (f: Fixture) => api.call('GET', `/api/projects/${f.projectId}`, { token: f.user.token });
const saveLines = (f: Fixture, lines: unknown[]) =>
  api.call('PATCH', `/api/projects/${f.projectId}/languages/hi/segments`, { token: f.user.token, body: { localizedSegments: lines } });
const retake = (f: Fixture) => api.call('POST', `/api/projects/${f.projectId}/languages/hi/retake`, { token: f.user.token });
const minutesUsed = async (f: Fixture) =>
  ((await db.collection('workspaces').doc(f.workspaceId).collection('meta').doc('usage').get()).get('minutesDubbed') as number) ?? 0;

describe('saving edited lines', () => {
  it('keeps the server fingerprints and slot timings, reviews the text, and reports what awaits a render', async () => {
    const f = await seedRenderedProject();
    await api.call('PUT', '/api/workspace/glossary', { token: f.user.token, body: { entries: [{ id: 'g1', term: 'ScatterPie', mode: 'keep' }] } });
    const before = (await getProject(f)).body;
    expect(before.retakeInfo).toBeUndefined();

    const [first, second] = before.localizedSegments as LocalizedSegment[];
    const res = await saveLines(f, [
      first,
      // The brand name got translated, and the client tried to forge a fingerprint and shrink the slot.
      { ...second, translatedText: 'स्कैटरपाई में स्वागत है', renderKey: 'forged', endTime: second.startTime + 0.01, isEdited: true },
    ]);
    expect(res.status).toBe(200);
    const saved = res.body.localizedSegments as LocalizedSegment[];
    expect(saved[1].renderKey).toBe(second.renderKey);
    expect(saved[1].endTime).toBe(second.endTime);
    expect(saved[1].qaFlags).toEqual(['glossary']);
    expect(saved[0].qaFlags).toBeUndefined();
    expect(res.body.retakeInfo).toEqual({ hi: { changedLineIds: [second.id], seconds: 4, minutes: 0.1 } });
  });
});

describe('retaking edited lines', () => {
  it('refuses when nothing changed, or when the render predates fingerprints', async () => {
    const f = await seedRenderedProject();
    const nothing = await retake(f);
    expect(nothing.status).toBe(400);
    expect(nothing.body.error.code).toBe('NOTHING_TO_RETAKE');

    const legacy = await seedRenderedProject({ legacy: true });
    const unavailable = await retake(legacy);
    expect(unavailable.status).toBe(400);
    expect(unavailable.body.error.code).toBe('RETAKE_UNAVAILABLE');
  });

  it('re-renders just that language and charges only the changed lines', async () => {
    const f = await seedRenderedProject();
    const lines = (await getProject(f)).body.localizedSegments as LocalizedSegment[];
    await saveLines(f, [lines[0], { ...lines[1], translatedText: 'ScatterPie में फिर से स्वागत है', isEdited: true }]);

    const seen: { job?: DubJob } = {};
    setDubPipelineForTests(async (job): Promise<PipelineResult> => {
      seen.job = job;
      return { completed: ['hi'], wordsCount: 1, fileSizeMb: 1, projectPatch: { status: 'completed', progressPercent: 100 } };
    });
    const res = await retake(f);
    expect(res.status).toBe(202);
    expect(res.body.changedLines).toBe(1);
    const job = await waitFor(() => getJob(res.body.jobId), (j) => Boolean(j?.settled));
    expect(job?.status).toBe('completed');
    expect(seen.job?.languages).toEqual(['hi']);
    expect(job?.minutesReserved).toBe(0.1);
    expect(await minutesUsed(f)).toBe(0.1);
  });
});
