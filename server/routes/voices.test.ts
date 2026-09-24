import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, db, resetEmulators, startApi, type TestApi } from '../test/helpers';
import { bucket } from '../lib/firebaseAdmin';
import { isOwnVoiceSamplePath } from '../lib/customVoices';

const UID = 'user123';
const GOOD = `users/${UID}/voices/0f8fad5b-d9cb-469f-a165-70867728950e/sample.wav`;

describe('isOwnVoiceSamplePath', () => {
  it('accepts only the caller’s own voice sample', () => {
    expect(isOwnVoiceSamplePath(UID, GOOD)).toBe(true);
  });

  it.each([
    ['another user', 'users/victim/voices/0f8fad5b-d9cb-469f-a165-70867728950e/sample.wav'],
    ['a workspace source video', 'workspaces/ws-1/projects/proj-1/source.mp4'],
    ['a dubbed output', 'workspaces/ws-1/projects/proj-1/dubbed_hi.mp4'],
    ['traversal out of the folder', `users/${UID}/voices/../../../workspaces/ws-1/projects/p/source.mp4`],
    ['traversal in place of the id', `users/${UID}/voices/../sample.wav`],
    ['a dot segment', `users/${UID}/voices/./sample.wav`],
    ['encoded traversal', `users/${UID}/voices/%2e%2e%2fworkspaces/sample.wav`],
    ['a doubled slash', `users/${UID}//voices/0f8fad5b-d9cb-469f-a165-70867728950e/sample.wav`],
    ['a leading slash', `/users/${UID}/voices/0f8fad5b-d9cb-469f-a165-70867728950e/sample.wav`],
    ['backslashes', `users\\${UID}\\voices\\0f8fad5b-d9cb-469f-a165-70867728950e\\sample.wav`],
    ['a different file name', `users/${UID}/voices/0f8fad5b-d9cb-469f-a165-70867728950e/source.mp4`],
    ['extra depth', `users/${UID}/voices/0f8fad5b-d9cb-469f-a165-70867728950e/x/sample.wav`],
    ['a non-uuid folder', `users/${UID}/voices/not-a-uuid/sample.wav`],
    ['uid as a prefix of another uid', `users/${UID}x/voices/0f8fad5b-d9cb-469f-a165-70867728950e/sample.wav`],
    ['a trailing newline', `${GOOD}\n`],
    ['an empty string', ''],
  ])('rejects %s', (_label, candidate) => {
    expect(isOwnVoiceSamplePath(UID, candidate)).toBe(false);
  });

  it('rejects non-string and missing values', () => {
    for (const bad of [undefined, null, 42, {}, ['users', UID]]) expect(isOwnVoiceSamplePath(UID, bad)).toBe(false);
    expect(isOwnVoiceSamplePath('', GOOD)).toBe(false);
  });
});

describe('tampered voice documents', () => {
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

  it('never lists, uses or deletes a file outside the caller’s voice folder', async () => {
    const attacker = await createUser('attacker@evil.test');
    const victimFile = 'workspaces/ws-victim/projects/proj-victim/source.mp4';
    await bucket.file(victimFile).save(Buffer.from('victim video'), { contentType: 'video/mp4', resumable: false });

    // What a client could write under permissive rules: a voice document pointing at someone else's media.
    const voiceId = 'cloned:0f8fad5b-d9cb-469f-a165-70867728950e';
    await db.collection('users').doc(attacker.uid).collection('voices').doc(voiceId).set({
      id: voiceId,
      ownerUid: attacker.uid,
      name: 'Evil',
      gender: 'male',
      languageCode: 'en',
      sampleStoragePath: victimFile,
      sampleTranscript: '',
      createdAt: new Date().toISOString(),
    });

    const list = await api.call('GET', '/api/voices', { token: attacker.token });
    expect(list.status).toBe(200);
    expect(list.body.voices).toEqual([]);
    expect(JSON.stringify(list.body)).not.toContain('ws-victim');

    const tts = await api.call('POST', '/api/tts/generate', { token: attacker.token, body: { text: 'hi', voiceId } });
    expect(tts.status).toBe(400);

    expect((await api.call('DELETE', `/api/voices/${encodeURIComponent(voiceId)}`, { token: attacker.token })).status).toBe(204);
    const [stillThere] = await bucket.file(victimFile).exists();
    expect(stillThere).toBe(true);
  });
});
