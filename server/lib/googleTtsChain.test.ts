import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ synthesize: vi.fn(), listVoices: vi.fn(), gemini: vi.fn() }));

vi.mock('./credentials', () => ({ hasGoogleCredentials: () => true, useAdc: true, gcpServiceAccountPath: '' }));
vi.mock('./env', async (importOriginal) => {
  const original = await importOriginal<typeof import('./env')>();
  return {
    env: {
      ...original.env,
      ttsEngine: 'gemini',
      geminiTtsLiteModel: 'gemini-3.8-flash-lite-tts',
      geminiTtsFlashModel: 'gemini-3.8-flash-tts',
      geminiTtsPremiumModel: 'gemini-3.1-flash-tts-preview',
    },
  };
});
vi.mock('./geminiSpeech', () => ({ geminiSpeechSynthesize: mocks.gemini }));
vi.mock('@google-cloud/text-to-speech', () => ({
  default: {
    TextToSpeechClient: class {
      synthesizeSpeech = mocks.synthesize;
      listVoices = mocks.listVoices;
    },
  },
}));

import type { VoiceEngine } from '../../src/types';
import { googleSynthesizeSpeech, resetGeminiTtsStateForTests, ttsRouteFor } from './googleTtsClient';

const LITE = 'gemini-3.8-flash-lite-tts';
const FLASH = 'gemini-3.8-flash-tts';
const PREMIUM = 'gemini-3.1-flash-tts-preview';
const STARTER: VoiceEngine[] = ['gemini-flash-lite'];
const ENTERPRISE: VoiceEngine[] = ['gemini-flash-lite', 'gemini-flash', 'chirp'];

const httpError = (status: number, name: string) => Object.assign(new Error(`${status} ${name}: nope`), { status });
const cloudModelOf = (request: { voice: { modelName?: string } }) => request.voice.modelName;

beforeEach(() => {
  resetGeminiTtsStateForTests();
  mocks.synthesize.mockReset();
  mocks.gemini.mockReset();
  mocks.gemini.mockImplementation(async (model: string) => Buffer.from(model));
  mocks.synthesize.mockImplementation(async (request: any) => [{ audioContent: Buffer.from(cloudModelOf(request) ?? 'chirp') }]);
  mocks.listVoices.mockResolvedValue([
    {
      voices: [
        { name: 'hi-IN-Chirp3-HD-Kore', languageCodes: ['hi-IN'], ssmlGender: 'FEMALE' },
        { name: 'bn-IN-Chirp3-HD-Kore', languageCodes: ['bn-IN'], ssmlGender: 'FEMALE' },
      ],
    },
  ]);
});

describe('voice engine routes', () => {
  it('voices Starter with Flash-Lite alone, keeping Chirp 3 HD only as the safety net', () => {
    expect(ttsRouteFor('gemini-flash-lite', { engines: STARTER })).toEqual({ gemini: [LITE], chirp: 'fallback' });
    expect(ttsRouteFor('gemini-flash-lite', { engines: STARTER, premium: true })).toEqual({ gemini: [PREMIUM, LITE], chirp: 'fallback' });
  });

  it('lets Enterprise voices stand in for each other, cheapest last', () => {
    expect(ttsRouteFor('gemini-flash', { engines: ENTERPRISE })).toEqual({ gemini: [FLASH, LITE], chirp: 'fallback' });
    expect(ttsRouteFor('gemini-flash-lite', { engines: ENTERPRISE })).toEqual({ gemini: [LITE], chirp: 'fallback' });
    expect(ttsRouteFor('chirp', { engines: ENTERPRISE })).toEqual({ gemini: [FLASH, LITE], chirp: 'first' });
  });
});

describe('googleSynthesizeSpeech', () => {
  it('voices a Gemini voice with its own model, passing the persona and the direction', async () => {
    const result = await googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female', 'Speak warmly.', ttsRouteFor('gemini-flash-lite', { engines: STARTER }));
    expect(result).toEqual({ audio: Buffer.from(LITE), engine: 'gemini', model: LITE });
    expect(mocks.gemini).toHaveBeenCalledWith(LITE, 'नमस्ते', 'Kore', 'Speak warmly.');
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('keeps a Starter line voiced when Flash-Lite is out of quota, by Chirp 3 HD in the same voice', async () => {
    mocks.gemini.mockRejectedValue(httpError(429, 'RESOURCE_EXHAUSTED'));
    const route = ttsRouteFor('gemini-flash-lite', { engines: STARTER });
    expect((await googleSynthesizeSpeech('एक', 'hi-IN', 'Kore', 'female', '', route)).engine).toBe('chirp');
    expect(mocks.synthesize.mock.calls[0][0].voice).toEqual({ languageCode: 'hi-IN', name: 'hi-IN-Chirp3-HD-Kore' });
    // Paused for a while, so the next line goes straight to Chirp 3 HD.
    expect((await googleSynthesizeSpeech('दो', 'hi-IN', 'Kore', 'female', '', route)).engine).toBe('chirp');
    expect(mocks.gemini).toHaveBeenCalledTimes(1);
  });

  it('falls back to the related language’s Chirp 3 HD voice for a dialect Chirp does not speak', async () => {
    mocks.gemini.mockRejectedValue(httpError(429, 'RESOURCE_EXHAUSTED'));
    const result = await googleSynthesizeSpeech('प्रणाम', 'bho-IN', 'Kore', 'female', '', ttsRouteFor('gemini-flash-lite', { engines: STARTER }), 'hi-IN');
    expect(result.engine).toBe('chirp');
    expect(mocks.synthesize.mock.calls[0][0].voice).toEqual({ languageCode: 'hi-IN', name: 'hi-IN-Chirp3-HD-Kore' });
  });

  it('hands a Flash line to Flash-Lite when Flash is withdrawn, and stops asking Flash', async () => {
    mocks.gemini.mockImplementation(async (model: string) => {
      if (model === FLASH) throw httpError(404, 'NOT_FOUND');
      return Buffer.from(model);
    });
    const route = ttsRouteFor('gemini-flash', { engines: ENTERPRISE });
    expect((await googleSynthesizeSpeech('एक', 'hi-IN', 'Kore', 'female', '', route)).model).toBe(LITE);
    await googleSynthesizeSpeech('दो', 'hi-IN', 'Kore', 'female', '', route);
    expect(mocks.gemini.mock.calls.filter(([model]) => model === FLASH)).toHaveLength(1);
  });

  it('voices a Chirp 3 HD voice with Chirp3-HD where it speaks the language', async () => {
    const result = await googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female', '', ttsRouteFor('chirp', { engines: ENTERPRISE }));
    expect(result.engine).toBe('chirp');
    expect(mocks.synthesize.mock.calls[0][0].voice).toEqual({ languageCode: 'hi-IN', name: 'hi-IN-Chirp3-HD-Kore' });
    expect(mocks.gemini).not.toHaveBeenCalled();
  });

  it('has Gemini 3.8 Flash speak a dialect Chirp3-HD does not cover, in the same persona', async () => {
    const result = await googleSynthesizeSpeech('प्रणाम', 'bho-IN', 'Kore', 'female', '', ttsRouteFor('chirp', { engines: ENTERPRISE }));
    expect(result).toEqual({ audio: Buffer.from(FLASH), engine: 'gemini', model: FLASH });
    expect(mocks.gemini).toHaveBeenCalledWith(FLASH, 'प्रणाम', 'Kore', '');
  });

  it('sends the premium model to Cloud TTS, with Bengali as bn-BD', async () => {
    const result = await googleSynthesizeSpeech('নমস্কার', 'bn-IN', 'Kore', 'female', 'x', ttsRouteFor('gemini-flash-lite', { engines: ENTERPRISE, premium: true }));
    expect(result.model).toBe(PREMIUM);
    expect(mocks.synthesize.mock.calls[0][0].voice).toEqual({ languageCode: 'bn-BD', name: 'Kore', modelName: PREMIUM });
    expect(mocks.synthesize.mock.calls[0][0].input).toEqual({ text: 'নমস্কার', prompt: 'x' });
  });

  it('performs tags on Gemini but never hands them to Chirp3-HD, which would read them out', async () => {
    mocks.gemini.mockRejectedValue(httpError(429, 'RESOURCE_EXHAUSTED'));
    const result = await googleSynthesizeSpeech('[laughing] वाह!', 'hi-IN', 'Kore', 'female', '', ttsRouteFor('gemini-flash', { engines: ENTERPRISE }));
    expect(result.engine).toBe('chirp');
    expect(mocks.gemini.mock.calls[0][1]).toBe('[laughing] वाह!');
    expect(mocks.synthesize.mock.calls[0][0].input.text).toBe('वाह!');
  });

  it('gives Chirp3-HD a beat of silence for a line that is only a laugh, instead of an empty request', async () => {
    const result = await googleSynthesizeSpeech('[laughing].', 'hi-IN', 'Kore', 'female', '', ttsRouteFor('chirp', { engines: ENTERPRISE }));
    expect(result.engine).toBe('chirp');
    expect(result.audio.toString('ascii', 0, 4)).toBe('RIFF');
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
