import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ synthesize: vi.fn(), listVoices: vi.fn() }));

vi.mock('./credentials', () => ({ hasGoogleCredentials: () => true, useAdc: true, gcpServiceAccountPath: '' }));
vi.mock('./env', async (importOriginal) => {
  const original = await importOriginal<typeof import('./env')>();
  return { env: { ...original.env, ttsEngine: 'gemini', geminiTtsModel: 'gemini-2.5-flash-tts' } };
});
vi.mock('@google-cloud/text-to-speech', () => ({
  default: {
    TextToSpeechClient: class {
      synthesizeSpeech = mocks.synthesize;
      listVoices = mocks.listVoices;
    },
  },
}));

import { googleSynthesizeSpeech, resetGeminiTtsStateForTests } from './googleTtsClient';

const grpcError = (code: number, name: string) => Object.assign(new Error(`${code} ${name}: nope`), { code });
const isGeminiCall = (request: { voice: { modelName?: string } }) => Boolean(request.voice.modelName);
const geminiCalls = () => mocks.synthesize.mock.calls.filter(([request]) => isGeminiCall(request)).length;

// Gemini answers according to `gemini`; the Chirp3-HD fallback always works.
function respond(gemini: (request: any) => unknown) {
  mocks.synthesize.mockImplementation(async (request: any) => {
    if (isGeminiCall(request)) return gemini(request);
    return [{ audioContent: Buffer.from('chirp') }];
  });
}

beforeEach(() => {
  resetGeminiTtsStateForTests();
  mocks.synthesize.mockReset();
  mocks.listVoices.mockResolvedValue([
    {
      voices: [
        { name: 'hi-IN-Chirp3-HD-Kore', languageCodes: ['hi-IN'], ssmlGender: 'FEMALE' },
        { name: 'ta-IN-Chirp3-HD-Kore', languageCodes: ['ta-IN'], ssmlGender: 'FEMALE' },
      ],
    },
  ]);
});

describe('Gemini-TTS with Chirp3-HD fallback', () => {
  it('voices a line with Gemini, passing the persona and the style direction', async () => {
    respond(() => [{ audioContent: Buffer.from('gemini') }]);
    const result = await googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female', 'Speak in a warm voice.');
    expect(result).toEqual({ audio: Buffer.from('gemini'), engine: 'gemini', model: 'gemini-2.5-flash-tts' });
    const [request] = mocks.synthesize.mock.calls[0];
    expect(request.voice).toEqual({ languageCode: 'hi-IN', name: 'Kore', modelName: 'gemini-2.5-flash-tts' });
    expect(request.input).toEqual({ text: 'नमस्ते', prompt: 'Speak in a warm voice.' });
  });

  it('falls back when Gemini is out of quota, and stops asking it for a while', async () => {
    respond(() => Promise.reject(grpcError(8, 'RESOURCE_EXHAUSTED')));
    expect((await googleSynthesizeSpeech('एक', 'hi-IN', 'Kore', 'female', 'x')).engine).toBe('chirp');
    expect((await googleSynthesizeSpeech('दो', 'hi-IN', 'Kore', 'female', 'x')).engine).toBe('chirp');
    expect(geminiCalls()).toBe(1);
  });

  it('skips a language Gemini keeps refusing, but only that language', async () => {
    respond((request) => (request.voice.languageCode === 'ta-IN' ? Promise.reject(grpcError(3, 'INVALID_ARGUMENT')) : [{ audioContent: Buffer.from('gemini') }]));
    for (let i = 0; i < 4; i++) expect((await googleSynthesizeSpeech(`வரி ${i}`, 'ta-IN', 'Kore', 'female')).engine).toBe('chirp');
    expect(geminiCalls()).toBe(3);
    expect((await googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female')).engine).toBe('gemini');
  });

  it('leaves transient failures to the caller’s retry instead of silently switching voices', async () => {
    respond(() => Promise.reject(grpcError(14, 'UNAVAILABLE')));
    await expect(googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female')).rejects.toThrow(/UNAVAILABLE/);
  });

  it('uses the standard voice when the user turned expressive voices off', async () => {
    respond(() => [{ audioContent: Buffer.from('gemini') }]);
    expect((await googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female', 'Speak warmly.', false)).engine).toBe('chirp');
    expect(geminiCalls()).toBe(0);
  });

  it('sends text too long for Gemini straight to Chirp3-HD', async () => {
    respond(() => [{ audioContent: Buffer.from('gemini') }]);
    expect((await googleSynthesizeSpeech('न'.repeat(2000), 'hi-IN', 'Kore', 'female')).engine).toBe('chirp');
    expect(geminiCalls()).toBe(0);
  });
});
