import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, db, resetEmulators, startApi, type TestApi } from '../test/helpers';
import { DEFAULT_PREFERENCES } from '../../src/data/preferences';

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

describe('GET /api/bootstrap', () => {
  it('returns everything the app opens with in one response', async () => {
    const user = await createUser('boot@team.test');
    await db.collection('users').doc(user.uid).set({ name: 'Boot User', role: 'editor', workspace: 'x' });
    await api.call('PUT', '/api/settings', { token: user.token, body: { preferences: { burnCaptions: true } } });
    const created = await api.call('POST', '/api/projects', { token: user.token, body: { title: 'First cut' } });
    expect(created.status).toBe(201);

    const res = await api.call('GET', '/api/bootstrap', { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body.workspace).toMatchObject({ myRole: 'admin', myUid: user.uid });
    expect(res.body.workspace.members).toHaveLength(1);
    expect(res.body.preferences).toEqual({ ...DEFAULT_PREFERENCES, burnCaptions: true });
    expect(res.body.usage).toMatchObject({ activePlan: 'Starter', minutesLimit: 50, minutesDubbed: 0 });
    expect(res.body.projects.map((p: { title: string }) => p.title)).toEqual(['First cut']);
    expect(res.body.profile).toEqual({ name: 'Boot User', role: 'editor', workspace: 'x' });
  });

  it('opens without a ScatterStudio profile and refuses anyone signed out', async () => {
    const user = await createUser('noprofile@team.test');
    const res = await api.call('GET', '/api/bootstrap', { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body.profile).toBeNull();
    expect((await api.call('GET', '/api/bootstrap')).status).toBe(401);
  });

  it('shows a saved preference straight away despite the settings cache', async () => {
    const user = await createUser('cache@team.test');
    expect((await api.call('GET', '/api/bootstrap', { token: user.token })).body.preferences.aiReview).toBe(false);
    await api.call('PUT', '/api/settings', { token: user.token, body: { preferences: { aiReview: true } } });
    expect((await api.call('GET', '/api/bootstrap', { token: user.token })).body.preferences.aiReview).toBe(true);
  });
});
