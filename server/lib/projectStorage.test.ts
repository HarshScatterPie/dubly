import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, db, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';
import { getStoredProject, updateStoredProject } from './projectRepo';
import { unsplitProjects } from '../scripts/unsplit_projects';

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

const seg = (i: number) => ({ id: `seg-${i}`, startTime: i, endTime: i + 1, text: `line ${i}`, speaker: 'Speaker 1', wordsCount: 2, confidence: 0.9, words: [{ text: 'line', start: i, end: i + 0.5 }] });
// Lines are in each language's own script, so the server's review of saved lines has nothing to flag and they round-trip unchanged.
const LINE_WORD: Record<string, string> = { hi: 'पंक्ति', ta: 'வரி' };
const loc = (code: string, i: number) => ({ id: `loc-${code}-seg-${i}`, segmentId: `seg-${i}`, startTime: i, endTime: i + 1, speaker: 'Speaker 1', sourceText: `line ${i}`, translatedText: `${LINE_WORD[code]} ${i}`, isEdited: false });

async function setup(user: TestUser) {
  const workspaceId = (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;
  return { workspaceId, col: db.collection('workspaces').doc(workspaceId).collection('projects') };
}

// A project exactly as it was stored before the split: everything inline in one document.
const legacyProject = (id: string, uid: string) => ({
  id,
  ownerUid: uid,
  title: 'Legacy',
  targetLanguage: 'hi',
  targetLanguages: ['hi', 'ta'],
  transcriptSegments: [seg(1), seg(2)],
  localizedSegments: [loc('hi', 1), loc('hi', 2)],
  languageOutputs: {
    hi: { languageCode: 'hi', localizedSegments: [loc('hi', 1), loc('hi', 2)], status: 'completed', progressPercent: 100, finalDubbedVideoStoragePath: 'workspaces/x/projects/p/dubbed_hi.mp4' },
    ta: { languageCode: 'ta', localizedSegments: [loc('ta', 1), loc('ta', 2)], status: 'completed', progressPercent: 100 },
  },
  status: 'completed',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

describe('project storage layout', () => {
  it('stores new projects as metadata plus separate segment documents', async () => {
    const user = await createUser('new@team.test');
    const { col } = await setup(user);
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Fresh', targetLanguage: 'hi' } });
    const doc = (await col.doc(created.body.id).get()).data()!;
    expect(doc.segmentsStorage).toBe('split');
    expect(doc.transcriptSegments).toBeUndefined();
    expect(doc.localizedSegments).toBeUndefined();
    expect((await col.doc(created.body.id).collection('content').doc('transcript').get()).exists).toBe(true);
    expect(created.body.transcriptSegments).toEqual([]);
  });

  it('reads an old all-in-one project unchanged, then moves it on its first write without losing anything', async () => {
    const user = await createUser('legacy@team.test');
    const { workspaceId, col } = await setup(user);
    await col.doc('proj-legacy').set(legacyProject('proj-legacy', user.uid));

    const before = await api.call('GET', '/api/projects/proj-legacy', { token: user.token });
    expect(before.status).toBe(200);
    expect(before.body.transcriptSegments).toEqual([seg(1), seg(2)]);
    expect(before.body.languageOutputs.ta.localizedSegments).toEqual([loc('ta', 1), loc('ta', 2)]);

    // A write that touches no segments still moves them all out.
    const renamed = await api.call('PATCH', '/api/projects/proj-legacy', { token: user.token, body: { title: 'Renamed' } });
    expect(renamed.status).toBe(200);
    const raw = (await col.doc('proj-legacy').get()).data()!;
    expect(raw.segmentsStorage).toBe('split');
    expect(raw.transcriptSegments).toBeUndefined();
    expect(raw.localizedSegments).toBeUndefined();
    expect(raw.languageOutputs.hi.localizedSegments).toBeUndefined();
    expect(raw.languageOutputs.hi.finalDubbedVideoStoragePath).toBe('workspaces/x/projects/p/dubbed_hi.mp4');
    expect(raw.title).toBe('Renamed');

    const after = await getStoredProject(workspaceId, 'proj-legacy');
    expect(after?.transcriptSegments).toEqual(before.body.transcriptSegments);
    expect(after?.localizedSegments).toEqual(before.body.localizedSegments);
    expect(after?.languageOutputs?.hi.localizedSegments).toEqual(before.body.languageOutputs.hi.localizedSegments);
    expect(after?.languageOutputs?.ta.localizedSegments).toEqual(before.body.languageOutputs.ta.localizedSegments);
    expect(after?.languageOutputs?.hi.status).toBe('completed');
  });

  it('routes per-language edits and primary-language edits to the same language document', async () => {
    const user = await createUser('edit@team.test');
    const { workspaceId, col } = await setup(user);
    await col.doc('proj-edit').set(legacyProject('proj-edit', user.uid));

    const taEdit = [{ ...loc('ta', 1), translatedText: 'திருத்திய வரி', isEdited: true }];
    expect((await api.call('PATCH', '/api/projects/proj-edit/languages/ta/segments', { token: user.token, body: { localizedSegments: taEdit } })).status).toBe(200);
    const hiEdit = [{ ...loc('hi', 1), translatedText: 'संपादित पंक्ति', isEdited: true }];
    expect((await api.call('PATCH', '/api/projects/proj-edit', { token: user.token, body: { localizedSegments: hiEdit } })).status).toBe(200);

    const project = await getStoredProject(workspaceId, 'proj-edit');
    expect(project?.languageOutputs?.ta.localizedSegments).toEqual(taEdit);
    expect(project?.localizedSegments).toEqual(hiEdit);
    expect(project?.languageOutputs?.hi.localizedSegments).toEqual(hiEdit);
    expect((await col.doc('proj-edit').collection('languages').doc('ta').get()).get('segments')).toEqual(taEdit);
  });

  it('follows a change of primary language', async () => {
    const user = await createUser('primary@team.test');
    const { workspaceId, col } = await setup(user);
    await col.doc('proj-p').set(legacyProject('proj-p', user.uid));
    await updateStoredProject(workspaceId, 'proj-p', { targetLanguage: 'ta' });
    expect((await getStoredProject(workspaceId, 'proj-p'))?.localizedSegments).toEqual([loc('ta', 1), loc('ta', 2)]);
  });

  it('deletes the segment documents with the project', async () => {
    const user = await createUser('delete@team.test');
    const { col } = await setup(user);
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Doomed' } });
    await api.call('PATCH', `/api/projects/${created.body.id}`, { token: user.token, body: { transcriptSegments: [seg(1)] } });
    expect((await api.call('DELETE', `/api/projects/${created.body.id}`, { token: user.token })).status).toBe(204);
    expect((await col.doc(created.body.id).get()).exists).toBe(false);
    expect((await col.doc(created.body.id).collection('content').doc('transcript').get()).exists).toBe(false);
    expect((await col.doc(created.body.id).collection('languages').get()).size).toBe(0);
  });

  it('can be rolled back: the unsplit script rejoins projects so pre-split code can read them', async () => {
    const user = await createUser('rollback@team.test');
    const { workspaceId, col } = await setup(user);
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Split', targetLanguage: 'hi' } });
    await api.call('PATCH', `/api/projects/${created.body.id}`, { token: user.token, body: { transcriptSegments: [seg(1)], localizedSegments: [loc('hi', 1)] } });

    expect((await unsplitProjects(false)).unsplit).toHaveLength(1);
    expect((await col.doc(created.body.id).get()).get('transcriptSegments')).toBeUndefined();
    await unsplitProjects(true);
    const raw = (await col.doc(created.body.id).get()).data()!;
    expect(raw.transcriptSegments).toEqual([seg(1)]);
    expect(raw.localizedSegments).toEqual([loc('hi', 1)]);
    expect(raw.segmentsStorage).toBeNull();
    // The current code reads the rejoined project too.
    expect((await getStoredProject(workspaceId, created.body.id))?.transcriptSegments).toEqual([seg(1)]);
  });

  it('refuses a segment list too large for one document with a clear error instead of a Firestore failure', async () => {
    const user = await createUser('huge@team.test');
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Huge' } });
    const huge = Array.from({ length: 3000 }, (_, i) => ({ ...seg(i), text: 'x'.repeat(400) }));
    const res = await api.call('PATCH', `/api/projects/${created.body.id}`, { token: user.token, body: { transcriptSegments: huge } });
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PROJECT_TOO_LARGE');
  });
});
