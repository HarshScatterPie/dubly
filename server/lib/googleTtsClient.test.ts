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

const ENTERPRISE: VoiceEngine[] = ['gemini-flash-lite', 'gemini-flash', 'chirp'];
const liteRoute = () => ttsRouteFor('gemini-flash-lite', { engines: ENTERPRISE });

const httpError = (status: number, name: string) => Object.assign(new Error(`${status} ${name}: nope`), { status });

beforeEach(() => {
  resetGeminiTtsStateForTests();
  mocks.synthesize.mockReset();
  mocks.gemini.mockReset();
  mocks.synthesize.mockResolvedValue([{ audioContent: Buffer.from('chirp') }]);
  mocks.listVoices.mockResolvedValue([
    {
      voices: [
        { name: 'hi-IN-Chirp3-HD-Kore', languageCodes: ['hi-IN'], ssmlGender: 'FEMALE' },
        { name: 'ta-IN-Chirp3-HD-Kore', languageCodes: ['ta-IN'], ssmlGender: 'FEMALE' },
      ],
    },
  ]);
});

describe('Gemini voices with Chirp3-HD behind them (Enterprise)', () => {
  it('falls back when Gemini is out of quota, and stops asking it for a while', async () => {
    mocks.gemini.mockRejectedValue(httpError(429, 'RESOURCE_EXHAUSTED'));
    expect((await googleSynthesizeSpeech('एक', 'hi-IN', 'Kore', 'female', 'x', liteRoute())).engine).toBe('chirp');
    expect((await googleSynthesizeSpeech('दो', 'hi-IN', 'Kore', 'female', 'x', liteRoute())).engine).toBe('chirp');
    expect(mocks.gemini).toHaveBeenCalledTimes(1);
  });

  it('skips a language Gemini keeps refusing, but only that language', async () => {
    mocks.gemini.mockImplementation(async (_model: string, text: string) => {
      if (/[஀-௿]/.test(text)) throw httpError(400, 'INVALID_ARGUMENT');
      return Buffer.from('gemini');
    });
    for (let i = 0; i < 4; i++) expect((await googleSynthesizeSpeech(`வரி ${i}`, 'ta-IN', 'Kore', 'female', '', liteRoute())).engine).toBe('chirp');
    expect(mocks.gemini).toHaveBeenCalledTimes(3);
    expect((await googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female', '', liteRoute())).engine).toBe('gemini');
  });

  it('leaves transient failures to the caller’s retry instead of silently switching voices', async () => {
    mocks.gemini.mockRejectedValue(Object.assign(new Error('14 UNAVAILABLE: try later'), { code: 14 }));
    await expect(googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female', '', liteRoute())).rejects.toThrow(/UNAVAILABLE/);
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('skips the premium model for text too long for Cloud TTS, and voices it with the voice’s own model', async () => {
    mocks.gemini.mockResolvedValue(Buffer.from('gemini'));
    const route = ttsRouteFor('gemini-flash-lite', { engines: ENTERPRISE, premium: true });
    const result = await googleSynthesizeSpeech('न'.repeat(2000), 'hi-IN', 'Kore', 'female', '', route);
    expect(result.model).toBe('gemini-3.8-flash-lite-tts');
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });

  it('voices every line with Chirp3-HD when the operator turns Gemini off', async () => {
    const { env } = await import('./env');
    const previous = env.ttsEngine;
    env.ttsEngine = 'chirp';
    try {
      const result = await googleSynthesizeSpeech('नमस्ते', 'hi-IN', 'Kore', 'female', '', liteRoute());
      expect(result.engine).toBe('chirp');
      expect(mocks.gemini).not.toHaveBeenCalled();
    } finally {
      env.ttsEngine = previous;
    }
  });
});
