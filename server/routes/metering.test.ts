import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createUser, readProject, replaceUsage, resetEmulators, seedProject as storeProject, startApi, usageOf as storedUsage, type TestApi, type TestUser } from '../test/helpers';
import { env } from '../lib/env';
import { silenceWav } from '../lib/audioUtils';
import { currentUsagePeriod } from '../lib/projectRepo';
import { setSpeechSynthesisForTests } from './tts';
import { setTranscriptionPipelineForTests, type TranscriptionOutcome } from './projects';
import { VOICES } from '../../src/data/mockData';

// What costs model money and is not a dub: voice clips (Studio, previews), analysis and translation.

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
  setSpeechSynthesisForTests(null);
  setTranscriptionPipelineForTests(null);
  env.newWorkspacePlan = 'starter';
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

async function until(ok: () => Promise<boolean> | boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
}

const voice = VOICES[0];
const workspaceIdOf = async (user: TestUser) => (await api.call('GET', '/api/workspace', { token: user.token })).body.id as string;
const usageOf = async (user: TestUser) => (await api.call('GET', '/api/usage', { token: user.token })).body;
const speak = (user: TestUser, text: string, extra: Record<string, unknown> = {}) =>
  api.call('POST', '/api/tts/generate', { token: user.token, body: { text, voiceId: voice.id, ...extra } });

// Every clip comes back this many seconds long, from the provider or from the cache as told; returns the texts voiced.
function voiceLasting(seconds: number, fromCache = false): string[] {
  const voiced: string[] = [];
  setSpeechSynthesisForTests(async (text) => {
    voiced.push(text);
    return { provider: 'vertex', engine: 'gemini', audio: silenceWav(seconds, 24000), fromCache };
  });
  return voiced;
}

describe('voice clips (Studio voiceovers and line previews)', () => {
  it('use minutes by the seconds the voice spoke, carrying part of a tenth on to the next clip', async () => {
    const user = await createUser('studio@meter.test');
    voiceLasting(4);
    const minutes: number[] = [];
    for (let i = 0; i < 3; i++) {
      expect((await speak(user, `Line number ${i} of the voiceover.`)).status).toBe(200);
      minutes.push((await usageOf(user)).minutesDubbed);
    }
    // 4 s, 8 s, 12 s of voice: the ledger counts tenths of a minute (6 s), and nothing is rounded up or lost on the way.
    expect(minutes).toEqual([0, 0.1, 0.2]);
    expect((await storedUsage(await workspaceIdOf(user)))?.voiceSecondsCarry).toBe(0);
    expect(await usageOf(user)).not.toHaveProperty('voiceSecondsCarry');
  });

  it('are free for a voice’s own sample line and for a take served from the cache, but not for a sample given new direction', async () => {
    const user = await createUser('samples@meter.test');
    voiceLasting(30);
    expect((await speak(user, voice.sampleQuote)).status).toBe(200);
    voiceLasting(30, true);
    expect((await speak(user, 'A line voiced before.')).status).toBe(200);
    expect((await usageOf(user)).minutesDubbed).toBe(0);

    voiceLasting(6);
    expect((await speak(user, voice.sampleQuote, { delivery: 'whispered, very slowly' })).status).toBe(200);
    expect((await usageOf(user)).minutesDubbed).toBe(0.1);
  });

  it('hold minutes before the voice is made: one the allowance cannot cover is refused without calling the voice', async () => {
    env.newWorkspacePlan = 'free';
    const user = await createUser('trial@meter.test');
    await replaceUsage(await workspaceIdOf(user), { minutesDubbed: 4.9, usagePeriod: 'lifetime' });
    const voiced = voiceLasting(3);

    // 100 characters are held as 0.2 min (12 characters a second, in whole tenths), more than the 0.1 left.
    const refused = await speak(user, 'x'.repeat(100));
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(refused.body.error.message).toMatch(/voice clip needs up to 0\.2 min but only 0\.1 free min are left/);
    expect(voiced).toHaveLength(0);
    expect((await usageOf(user)).minutesDubbed).toBe(4.9);

    expect((await speak(user, 'Hi')).status).toBe(200);
    expect(voiced).toEqual(['Hi']);
  });

  it('give the hold back when the voice fails', async () => {
    const user = await createUser('fails@meter.test');
    const workspaceId = await workspaceIdOf(user);
    const gate = deferred<never>();
    setSpeechSynthesisForTests(() => gate.promise);

    const pending = speak(user, 'A line the provider will fail on.');
    await until(async () => (await storedUsage(workspaceId))?.minutesDubbed === 0.1);
    gate.reject(new Error('provider down'));
    expect((await pending).status).toBe(500);
    expect((await usageOf(user)).minutesDubbed).toBe(0);
    expect((await storedUsage(workspaceId))?.usagePeriod).toBe(currentUsagePeriod());
  });

  it('are made at most two at a time per workspace', async () => {
    const user = await createUser('burst@meter.test');
    const gate = deferred<void>();
    let started = 0;
    setSpeechSynthesisForTests(async () => {
      started++;
      await gate.promise;
      return { provider: 'vertex', engine: 'gemini', audio: silenceWav(1, 24000), fromCache: false };
    });

    const first = [speak(user, 'First clip.'), speak(user, 'Second clip.')];
    await until(() => started === 2);
    const third = await speak(user, 'Third clip.');
    expect(third.status).toBe(429);
    expect(third.body.error.code).toBe('VOICE_BUSY');
    // A sample line is not held back by the clips being made.
    voiceLasting(1);
    expect((await speak(user, voice.sampleQuote)).status).toBe(200);

    gate.resolve();
    expect((await Promise.all(first)).map((r) => r.status)).toEqual([200, 200]);
  });
});

async function seedProject(user: TestUser, fields: Record<string, unknown> = {}) {
  const workspaceId = await workspaceIdOf(user);
  const projectId = `proj-meter-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await storeProject(workspaceId, {
    id: projectId,
    ownerUid: user.uid,
    title: 'Meter',
    videoStoragePath: `workspaces/${workspaceId}/projects/${projectId}/source.mp4`,
    videoDuration: 120,
    targetLanguage: 'hi',
    targetLanguages: ['hi'],
    transcriptSegments: [{ id: 's1', startTime: 0, endTime: 1, text: 'a', speaker: 'Speaker 1', wordsCount: 1 }],
    selectedVoiceId: 'google-hi-charon',
    voiceSpeed: 1,
    voicePitch: 1,
    status: 'draft',
    currentStep: 'understand',
    createdAt: now,
    updatedAt: now,
    ...fields,
  });
  return { workspaceId, projectId };
}

const analysis = (): TranscriptionOutcome => ({
  projectPatch: {
    transcriptSegments: [{ id: 'seg-1', startTime: 0, endTime: 1, text: 'hello', speaker: 'Speaker 1', wordsCount: 1, confidence: 0.9 }],
    sourceLanguage: 'en',
    wordsCount: 1,
    speakersCount: 1,
    currentStep: 'understand',
    progressPercent: 0,
    currentProcessingMessage: '',
  },
  result: { detectedLanguage: 'English', removedSegments: 0, sanitizeNote: '' },
});

describe('analysis', () => {
  it('needs minutes enough to dub the video once, and charges nothing either way', async () => {
    env.newWorkspacePlan = 'free';
    const user = await createUser('analyze@meter.test');
    setTranscriptionPipelineForTests(async () => analysis());

    const long = await seedProject(user, { videoDuration: 361 });
    const refused = await api.call('POST', `/api/projects/${long.projectId}/transcribe`, { token: user.token, headers: { Prefer: 'respond-async' } });
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('QUOTA_EXCEEDED');
    expect(refused.body.error.message).toMatch(/Dubbing this video needs 6\.1 min but only 5 free min are left\. Use a shorter video/);
    expect((await readProject(long.workspaceId, long.projectId))?.activeJobId).toBeUndefined();

    const short = await seedProject(user, { videoDuration: 300 });
    expect((await api.call('POST', `/api/projects/${short.projectId}/transcribe`, { token: user.token })).status).toBe(200);
    expect((await usageOf(user)).minutesDubbed).toBe(0);
  });
});

describe('translation', () => {
  const translate = (user: TestUser, projectId: string, body: Record<string, unknown>) =>
    api.call('POST', `/api/projects/${projectId}/translate`, { token: user.token, body });
  const hiLine = { id: 'loc-hi-s1', segmentId: 's1', startTime: 0, endTime: 1, sourceText: 'a', translatedText: 'ए', isEdited: false };

  it('refuses a transcript longer than its video could voice before any model is asked', async () => {
    const user = await createUser('long@meter.test');
    // A one-minute video holds 3,600 characters (60 a second).
    const { projectId } = await seedProject(user, {
      videoDuration: 60,
      transcriptSegments: [{ id: 's1', startTime: 0, endTime: 60, text: 'x'.repeat(3601), speaker: 'Speaker 1', wordsCount: 1 }],
    });
    const res = await translate(user, projectId, { targetLanguageCodes: ['hi'] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('TEXT_TOO_LONG');
  });

  it('needs minutes enough to dub the video once, but reusing translations that exist is never refused', async () => {
    const user = await createUser('spent@meter.test');
    const { workspaceId, projectId } = await seedProject(user, {
      languageOutputs: { hi: { languageCode: 'hi', status: 'draft', progressPercent: 0, localizedSegments: [hiLine] } },
      localizedSegments: [hiLine],
    });
    await replaceUsage(workspaceId, { minutesDubbed: 50, usagePeriod: currentUsagePeriod() });

    const reused = await translate(user, projectId, { targetLanguageCodes: ['hi'] });
    expect(reused.status).toBe(200);
    expect(reused.body.localizedSegments[0].translatedText).toBe('ए');

    for (const body of [{ targetLanguageCodes: ['hi', 'ta'] }, { targetLanguageCodes: ['hi'], regenerate: true }]) {
      const refused = await translate(user, projectId, body);
      expect(refused.status).toBe(403);
      expect(refused.body.error.code).toBe('QUOTA_EXCEEDED');
      expect(refused.body.error.message).toMatch(/used all 50 dubbing minutes for this month/);
    }
  });
});
