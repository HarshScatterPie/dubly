import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { col, createUser, resetEmulators, seedProject, startApi, type TestApi, type TestUser } from '../test/helpers';
import { getStoredProject, updateStoredProject } from './projectRepo';

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

const projects = () => col<Record<string, any> & { _id: string }>('projects');
const segments = () => col<Record<string, any> & { _id: string }>('projectSegments');

async function workspaceOf(user: TestUser): Promise<string> {
  return (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;
}

// A two-language project with lines in both, written the way the app writes one.
const twoLanguageProject = (id: string, uid: string) => ({
  id,
  ownerUid: uid,
  title: 'Two languages',
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
  it('stores a project as one small metadata document plus a document per transcript and language', async () => {
    const user = await createUser('new@team.test');
    const workspaceId = await workspaceOf(user);
    await seedProject(workspaceId, twoLanguageProject('proj-two', user.uid));

    const meta = (await projects().findOne({ _id: 'proj-two' }))!;
    expect(meta).toMatchObject({ workspaceId, id: 'proj-two', title: 'Two languages' });
    expect(meta.transcriptSegments).toBeUndefined();
    expect(meta.localizedSegments).toBeUndefined();
    expect(meta.languageOutputs.hi.localizedSegments).toBeUndefined();
    expect(meta.languageOutputs.hi.finalDubbedVideoStoragePath).toBe('workspaces/x/projects/p/dubbed_hi.mp4');
    expect((await segments().find({ projectId: 'proj-two' }).toArray()).map((d) => d._id).sort()).toEqual(['proj-two:lang:hi', 'proj-two:lang:ta', 'proj-two:transcript']);

    const read = await api.call('GET', '/api/projects/proj-two', { token: user.token });
    expect(read.status).toBe(200);
    expect(read.body.transcriptSegments).toEqual([seg(1), seg(2)]);
    expect(read.body.localizedSegments).toEqual([loc('hi', 1), loc('hi', 2)]);
    expect(read.body.languageOutputs.ta.localizedSegments).toEqual([loc('ta', 1), loc('ta', 2)]);
  });

  it('creates new projects in the same layout', async () => {
    const user = await createUser('fresh@team.test');
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Fresh', targetLanguage: 'hi' } });
    expect(created.status).toBe(201);
    expect(await segments().countDocuments({ _id: `${created.body.id}:transcript` })).toBe(1);
    expect(created.body.transcriptSegments).toEqual([]);
  });

  it('merges a nested patch field by field, so one language never wipes another', async () => {
    const user = await createUser('merge@team.test');
    const workspaceId = await workspaceOf(user);
    await seedProject(workspaceId, twoLanguageProject('proj-merge', user.uid));
    await updateStoredProject(workspaceId, 'proj-merge', { languageOutputs: { ta: { languageCode: 'ta', status: 'failed', progressPercent: 0 } } } as never);
    const after = await getStoredProject(workspaceId, 'proj-merge');
    expect(after?.languageOutputs?.ta.status).toBe('failed');
    expect(after?.languageOutputs?.ta.localizedSegments).toEqual([loc('ta', 1), loc('ta', 2)]);
    expect(after?.languageOutputs?.hi).toMatchObject({ status: 'completed', finalDubbedVideoStoragePath: 'workspaces/x/projects/p/dubbed_hi.mp4' });
  });

  it('routes per-language edits and primary-language edits to the same language document', async () => {
    const user = await createUser('edit@team.test');
    const workspaceId = await workspaceOf(user);
    await seedProject(workspaceId, twoLanguageProject('proj-edit', user.uid));

    const taEdit = [{ ...loc('ta', 1), translatedText: 'திருத்திய வரி', isEdited: true }];
    expect((await api.call('PATCH', '/api/projects/proj-edit/languages/ta/segments', { token: user.token, body: { localizedSegments: taEdit } })).status).toBe(200);
    const hiEdit = [{ ...loc('hi', 1), translatedText: 'संपादित पंक्ति', isEdited: true }];
    expect((await api.call('PATCH', '/api/projects/proj-edit', { token: user.token, body: { localizedSegments: hiEdit } })).status).toBe(200);

    const project = await getStoredProject(workspaceId, 'proj-edit');
    expect(project?.languageOutputs?.ta.localizedSegments).toEqual(taEdit);
    expect(project?.localizedSegments).toEqual(hiEdit);
    expect(project?.languageOutputs?.hi.localizedSegments).toEqual(hiEdit);
    expect((await segments().findOne({ _id: 'proj-edit:lang:ta' }))?.segments).toEqual(taEdit);
  });

  it('follows a change of primary language', async () => {
    const user = await createUser('primary@team.test');
    const workspaceId = await workspaceOf(user);
    await seedProject(workspaceId, twoLanguageProject('proj-p', user.uid));
    await updateStoredProject(workspaceId, 'proj-p', { targetLanguage: 'ta' });
    expect((await getStoredProject(workspaceId, 'proj-p'))?.localizedSegments).toEqual([loc('ta', 1), loc('ta', 2)]);
  });

  it('keeps every workspace to its own projects, even with a known project id', async () => {
    const owner = await createUser('owner@team.test');
    const other = await createUser('other@team.test');
    await seedProject(await workspaceOf(owner), twoLanguageProject('proj-private', owner.uid));
    expect(await getStoredProject(await workspaceOf(other), 'proj-private')).toBeNull();
    expect((await api.call('GET', '/api/projects/proj-private', { token: other.token })).status).toBe(404);
  });

  it('deletes the segment documents with the project', async () => {
    const user = await createUser('delete@team.test');
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Doomed' } });
    await api.call('PATCH', `/api/projects/${created.body.id}`, { token: user.token, body: { transcriptSegments: [seg(1)] } });
    expect((await api.call('DELETE', `/api/projects/${created.body.id}`, { token: user.token })).status).toBe(204);
    expect(await projects().countDocuments({ _id: created.body.id })).toBe(0);
    expect(await segments().countDocuments({ projectId: created.body.id })).toBe(0);
  });

  it('lists projects without their lines, with line counts kept up to date', async () => {
    const user = await createUser('list@team.test');
    const workspaceId = await workspaceOf(user);
    await seedProject(workspaceId, twoLanguageProject('proj-list', user.uid));
    const listed = (await api.call('GET', '/api/projects', { token: user.token })).body.find((p: { id: string }) => p.id === 'proj-list');
    expect(listed.summary).toBe(true);
    expect(listed.transcriptSegments).toEqual([]);
    expect(listed.localizedSegments).toEqual([]);
    expect(listed.languageOutputs.ta.localizedSegments).toEqual([]);
    expect(listed.languageOutputs.hi.finalDubbedVideoUrl).toMatch(/^\/api\/media\//);
    expect(listed.segmentCounts).toEqual({ transcript: 2, languages: { hi: 2, ta: 2 }, complete: true });

    const taEdit = [loc('ta', 1)];
    await api.call('PATCH', '/api/projects/proj-list/languages/ta/segments', { token: user.token, body: { localizedSegments: taEdit } });
    const boot = (await api.call('GET', '/api/bootstrap', { token: user.token })).body;
    expect(boot.projects[0].segmentCounts.languages).toEqual({ hi: 2, ta: 1 });
    expect(boot.projects[0].transcriptSegments).toEqual([]);
    // Opening it still gives the whole project.
    expect((await api.call('GET', '/api/projects/proj-list', { token: user.token })).body.transcriptSegments).toEqual([seg(1), seg(2)]);
  });

  it('counts the lines of a project stored before counts were kept, once', async () => {
    const user = await createUser('older@team.test');
    const workspaceId = await workspaceOf(user);
    await seedProject(workspaceId, twoLanguageProject('proj-older', user.uid));
    await projects().updateOne({ _id: 'proj-older' }, { $unset: { segmentCounts: '' } });
    const listed = (await api.call('GET', '/api/projects', { token: user.token })).body[0];
    expect(listed.segmentCounts).toEqual({ transcript: 2, languages: { hi: 2, ta: 2 }, complete: true });
    expect((await projects().findOne({ _id: 'proj-older' }))?.segmentCounts).toEqual({ transcript: 2, languages: { hi: 2, ta: 2 }, complete: true });
  });

  it('refuses a segment list too large for one document with a clear error instead of a database failure', async () => {
    const user = await createUser('huge@team.test');
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'Huge' } });
    const workspaceId = await workspaceOf(user);
    // ~17 MB of lines, past MongoDB's 16 MiB document limit (the HTTP body limit stops this size at the API, so it is written directly).
    const huge = Array.from({ length: 4300 }, (_, i) => ({ ...seg(i), text: 'x'.repeat(4000) }));
    await expect(updateStoredProject(workspaceId, created.body.id, { transcriptSegments: huge })).rejects.toMatchObject({ status: 413, code: 'PROJECT_TOO_LARGE' });
  });
});
