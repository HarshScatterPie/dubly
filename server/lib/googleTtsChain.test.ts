import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ synthesize: vi.fn(), listVoices: vi.fn() }));

vi.mock('./credentials', () => ({ hasGoogleCredentials: () => true, useAdc: true, gcpServiceAccountPath: '' }));
vi.mock('./env', async (importOriginal) => {
  const original = await importOriginal<typeof import('./env')>();
  return { env: { ...original.env, ttsEngine: 'gemini', geminiTtsModel: 'gemini-2.5-flash-tts', geminiTtsPremiumModel: 'gemini-3.1-flash-tts-preview' } };
});
vi.mock('@google-cloud/text-to-speech', () => ({
  default: {
    TextToSpeechClient: class {
      synthesizeSpeech = mocks.synthesize;
      listVoices = mocks.listVoices;
    },
  },
}));

import { geminiTtsModels, googleSynthesizeSpeech, resetGeminiTtsStateForTests } from './googleTtsClient';

const grpcError = (code: number, name: string) => Object.assign(new Error(`${code} ${name}: nope`), { code });
const modelOf = (request: { voice: { modelName?: string } }) => request.voice.modelName;

beforeEach(() => {
  resetGeminiTtsStateForTests();
  mocks.synthesize.mockReset();
  mocks.listVoices.mockResolvedValue([{ voices: [{ name: 'hi-IN-Chirp3-HD-Kore', languageCodes: ['hi-IN'], ssmlGender: 'FEMALE' }] }]);
});

describe('Gemini-TTS model chain', () => {
  it('uses only the standard model unless the user turned on premium voices', () => {
    expect(geminiTtsModels()).toEqual(['gemini-2.5-flash-tts']);
    expect(geminiTtsModels(true)).toEqual(['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-tts']);
  });

  it('never calls the premium model for a user who did not turn it on', async () => {
    mocks.synthesize.mockResolvedValue([{ audioContent: Buffer.from('ok') }]);
    expect((await googleSynthesizeSpeech('एक', 'hi-IN', 'Kore', 'female', 'x')).model).toBe('gemini-2.5-flash-tts');
    expect((await googleSynthesizeSpeech('एक', 'hi-IN', 'Kore', 'female', 'x', true, true)).model).toBe('gemini-3.1-flash-tts-preview');
    expect(mocks.synthesize.mock.calls.map(([request]) => modelOf(request))).toEqual(['gemini-2.5-flash-tts', 'gemini-3.1-flash-tts-preview']);
  });

  it('hands a premium line to the standard model when the premium model is withdrawn, and stops asking the premium model', async () => {
    mocks.synthesize.mockImplementation(async (request: any) => {
      if (modelOf(request) === 'gemini-3.1-flash-tts-preview') throw grpcError(5, 'NOT_FOUND');
      return [{ audioContent: Buffer.from(modelOf(request) ?? 'chirp') }];
    });
    expect(await googleSynthesizeSpeech('एक', 'hi-IN', 'Kore', 'female', 'x', true, true)).toEqual({ audio: Buffer.from('gemini-2.5-flash-tts'), engine: 'gemini', model: 'gemini-2.5-flash-tts' });
    await googleSynthesizeSpeech('दो', 'hi-IN', 'Kore', 'female', 'x', true, true);
    const previewCalls = mocks.synthesize.mock.calls.filter(([request]) => modelOf(request) === 'gemini-3.1-flash-tts-preview').length;
    expect(previewCalls).toBe(1);
  });

  it('sends Bengali to Gemini voices as bn-BD, the locale they serve', async () => {
    mocks.synthesize.mockResolvedValue([{ audioContent: Buffer.from('ok') }]);
    await googleSynthesizeSpeech('নমস্কার', 'bn-IN', 'Kore', 'female');
    expect(mocks.synthesize.mock.calls[0][0].voice.languageCode).toBe('bn-BD');
  });

  it('performs tags on Gemini but never hands them to Chirp3-HD, which would read them out', async () => {
    mocks.synthesize.mockImplementation(async (request: any) => {
      if (modelOf(request)) throw grpcError(8, 'RESOURCE_EXHAUSTED');
      return [{ audioContent: Buffer.from('chirp') }];
    });
    const result = await googleSynthesizeSpeech('[laughing] वाह!', 'hi-IN', 'Kore', 'female');
    expect(result.engine).toBe('chirp');
    const geminiRequest = mocks.synthesize.mock.calls.find(([request]) => modelOf(request))![0];
    const chirpRequest = mocks.synthesize.mock.calls.find(([request]) => !modelOf(request))![0];
    expect(geminiRequest.input.text).toBe('[laughing] वाह!');
    expect(chirpRequest.input.text).toBe('वाह!');
  });

  it('gives Chirp3-HD a beat of silence for a line that is only a laugh, instead of an empty request', async () => {
    mocks.synthesize.mockImplementation(async (request: any) => {
      if (modelOf(request)) throw grpcError(8, 'RESOURCE_EXHAUSTED');
      throw new Error('Chirp3-HD must not be called with no words');
    });
    const result = await googleSynthesizeSpeech('[laughing].', 'hi-IN', 'Kore', 'female');
    expect(result.engine).toBe('chirp');
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF');
  });
});
