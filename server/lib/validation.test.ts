import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, resetEmulators, startApi, type TestApi, type TestUser } from '../test/helpers';

let api: TestApi;
let user: TestUser;
let projectId: string;

beforeAll(async () => {
  api = await startApi();
});
afterAll(async () => {
  await api.close();
});
beforeEach(async () => {
  await resetEmulators();
  user = await createUser('validator@team.test');
  projectId = (await api.call('POST', '/api/projects', { token: user.token, body: { title: 'V', targetLanguage: 'hi' } })).body.id;
});

const call = (method: string, path: string, body: unknown) => api.call(method, path, { token: user.token, body });
const expectRejected = (res: { status: number; body: any }) => {
  expect(res.status).toBe(400);
  expect(res.body.error.code).toBe('VALIDATION_FAILED');
};

const segment = { id: 'seg-1', startTime: 0, endTime: 2.5, text: 'Hello there', speaker: 'Speaker 1', wordsCount: 2, confidence: 0.9, words: [{ text: 'Hello', start: 0, end: 1 }] };
const localized = { id: 'loc-hi-seg-1', segmentId: 'seg-1', startTime: 0, endTime: 2.5, speaker: 'Speaker 1', sourceText: 'Hello there', translatedText: 'नमस्ते', isEdited: true };

describe('request validation', () => {
  it('accepts the bodies the UI actually sends', async () => {
    // App.tsx's save from the project workspace.
    const save = await call('PATCH', `/api/projects/${projectId}`, { title: 'Renamed', selectedVoiceId: 'google-hi-charon', transcriptSegments: [segment], localizedSegments: [localized] });
    expect(save.status).toBe(200);
    expect(save.body.title).toBe('Renamed');
    expect(save.body.localizedSegments[0].translatedText).toBe('नमस्ते');
    expect((await call('PATCH', `/api/projects/${projectId}/languages/hi/segments`, { localizedSegments: [localized] })).status).toBe(200);
    expect((await call('PUT', '/api/settings', { sttProvider: 'auto', translateProvider: 'vertex', ttsProvider: 'auto' })).status).toBe(200);
  });

  it.each([
    ['a title of the wrong type', { title: 42 }],
    ['an empty title', { title: '   ' }],
    ['an unknown emotion', { voiceEmotion: 'furious' }],
    ['an out-of-range speed', { voiceSpeed: 10 }],
    ['a non-numeric pitch', { voicePitch: 'high' }],
    ['a segment missing its text', { transcriptSegments: [{ id: 's', startTime: 0, endTime: 1 }] }],
    ['a segment with absurd timing', { transcriptSegments: [{ ...segment, endTime: 1e12 }] }],
    ['segments that are not a list', { localizedSegments: { 0: localized } }],
    ['a translation longer than any real line', { localizedSegments: [{ ...localized, translatedText: 'x'.repeat(5001) }] }],
    ['too many segments', { transcriptSegments: Array.from({ length: 5001 }, (_, i) => ({ ...segment, id: `s${i}`, words: undefined })) }],
    ['a voice map with a non-string voice', { languageVoiceMap: { hi: 7 } }],
    ['an unknown step', { currentStep: 'publish' }],
  ])('rejects a project update with %s', async (_label, body) => {
    expectRejected(await call('PATCH', `/api/projects/${projectId}`, body));
  });

  it('drops fields a client may not set instead of storing them', async () => {
    const res = await call('PATCH', `/api/projects/${projectId}`, { title: 'OK', status: 'completed', ownerUid: 'someone-else', videoStoragePath: 'workspaces/other/x.mp4' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('draft');
  });

  it('rejects malformed bodies on the other write endpoints', async () => {
    expectRejected(await call('POST', `/api/projects/${projectId}/translate`, { targetLanguageCodes: 'hi' }));
    expectRejected(await call('POST', `/api/projects/${projectId}/translate`, { style: 'shouty' }));
    expectRejected(await call('POST', `/api/projects/${projectId}/dub`, { languages: 'hi' }));
    expectRejected(await call('POST', `/api/projects/${projectId}/dub`, { languageSpeakerVoiceMap: { hi: 'not-a-map' } }));
    expectRejected(await call('POST', `/api/projects/${projectId}/export-video`, { captions: 'yes' }));
    expectRejected(await call('PATCH', `/api/projects/${projectId}/languages/hi/segments`, {}));
    expectRejected(await call('PUT', '/api/settings', { ttsProvider: 'openai' }));
    expectRejected(await call('POST', '/api/tts/generate', { voiceId: 'google-hi-charon' }));
    expectRejected(await call('POST', '/api/tts/generate', { text: 'hi', voiceId: 'google-hi-charon', speed: 99 }));
    expectRejected(await call('PATCH', '/api/workspace', { name: '' }));
    expectRejected(await call('POST', '/api/workspace/invites', { email: 'a@b.co', role: 'owner' }));
    expectRejected(await call('POST', '/api/invites/accept', { token: 5 }));
  });

  it('puts no length limit on text-to-voice text', async () => {
    // Passes validation and fails only later, on the (deliberately unknown) voice.
    const res = await call('POST', '/api/tts/generate', { text: 'long '.repeat(10_000), voiceId: 'no-such-voice' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).not.toBe('VALIDATION_FAILED');
  });

  it('answers a broken JSON body with a 400, not a crash', async () => {
    const res = await fetch(`${api.baseUrl}/api/projects/${projectId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
      body: '{"title": ',
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('INVALID_REQUEST');
  });
});
