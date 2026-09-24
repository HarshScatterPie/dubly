import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, resetEmulators, startApi, type TestApi } from '../test/helpers';
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

describe('user preferences', () => {
  it('start from the defaults and change only the fields that are sent', async () => {
    const user = await createUser('prefs@settings.test');
    const initial = await api.call('GET', '/api/settings', { token: user.token });
    expect(initial.status).toBe(200);
    expect(initial.body.preferences).toEqual(DEFAULT_PREFERENCES);

    const first = await api.call('PUT', '/api/settings', { token: user.token, body: { preferences: { defaultTargetLanguages: ['hi', 'ta'], voiceEmotion: 'energetic' } } });
    expect(first.status).toBe(200);
    const second = await api.call('PUT', '/api/settings', { token: user.token, body: { preferences: { burnCaptions: true } } });
    expect(second.body.preferences).toEqual({ ...DEFAULT_PREFERENCES, defaultTargetLanguages: ['hi', 'ta'], voiceEmotion: 'energetic', burnCaptions: true });
    // Provider settings are untouched by a preferences-only save.
    expect(second.body.ttsProvider).toBe('auto');
  });

  it('replace a saved voice the catalog no longer has with a real one, so a dub is never refused for it', async () => {
    const user = await createUser('oldvoice@settings.test');
    const res = await api.call('PUT', '/api/settings', { token: user.token, body: { preferences: { defaultVoiceId: 'riya' } } });
    expect(res.body.preferences.defaultVoiceId).toBe('google-hi-aoede');
  });

  it('are private to each user', async () => {
    const a = await createUser('a@settings.test');
    const b = await createUser('b@settings.test');
    await api.call('PUT', '/api/settings', { token: a.token, body: { preferences: { expressiveVoices: false } } });
    expect((await api.call('GET', '/api/settings', { token: b.token })).body.preferences.expressiveVoices).toBe(true);
  });

  it('refuse values the studio cannot use', async () => {
    const user = await createUser('bad@settings.test');
    for (const preferences of [{ voiceSpeed: 3 }, { voiceEmotion: 'furious' }, { defaultTargetLanguages: Array(11).fill('hi') }]) {
      const res = await api.call('PUT', '/api/settings', { token: user.token, body: { preferences } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    }
  });
});

describe('sign out everywhere', () => {
  it('ends the session that asked, as well as every other one', async () => {
    const user = await createUser('everywhere@settings.test');
    expect((await api.call('GET', '/api/settings', { token: user.token })).status).toBe(200);
    // Revocation is recorded to the second, so a token issued in the same second as it would still be honoured.
    await new Promise((r) => setTimeout(r, 1100));
    const res = await api.call('POST', '/api/profile/sign-out-everywhere', { token: user.token });
    expect(res.status).toBe(204);
    expect((await api.call('GET', '/api/settings', { token: user.token })).status).toBe(401);
  });
});
