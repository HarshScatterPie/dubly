import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Model work a re-render repeats with the same input (a retake re-renders the whole language) must be reused, not bought again.
const mocks = vi.hoisted(() => ({ generate: vi.fn(), synthesize: vi.fn(), listVoices: vi.fn() }));

vi.mock('./credentials', () => ({ hasGoogleCredentials: () => true, useAdc: true, gcpServiceAccountPath: '' }));
vi.mock('./env', async (importOriginal) => {
  const original = await importOriginal<typeof import('./env')>();
  return { env: { ...original.env, ttsEngine: 'cloud', vertexProjectId: 'demo-test' } };
});
// A cache of its own, so nothing a developer's server cached can answer for the model here.
vi.mock('./paths', async (importOriginal) => {
  const original = await importOriginal<typeof import('./paths')>();
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  return { ...original, cacheDir: path.join(tmpdir(), `dubly-ai-reuse-${process.pid}-${Date.now()}`) };
});
vi.mock('./geminiSpeech', () => ({ geminiSpeechSynthesize: vi.fn(), isGeminiSpeechConfigured: () => false }));
vi.mock('@google/genai', async (importOriginal) => {
  const original = await importOriginal<typeof import('@google/genai')>();
  return {
    ...original,
    GoogleGenAI: class {
      models = { generateContent: mocks.generate };
    },
  };
});
vi.mock('@google-cloud/text-to-speech', () => ({
  default: {
    TextToSpeechClient: class {
      synthesizeSpeech = mocks.synthesize;
      listVoices = mocks.listVoices;
    },
  },
}));

import { rm } from 'node:fs/promises';
import { cacheDir } from './paths';
import { vertexCondenseLine, vertexHinglishToSpeechScript } from './vertexClient';
import { reviewDubbedLines } from './dubDirector';
import { routeSynthesizeSpeech } from './modelRouter';
import { resetGeminiTtsStateForTests } from './googleTtsClient';
import { pcmToWav } from './audioUtils';
import { VOICES } from '../../src/data/mockData';

const reply = (text: string) => ({ text, usageMetadata: {} });
const linesIn = (request: { contents: unknown }) => JSON.parse(String(request.contents).split('Lines:\n')[1]) as { id: string; text: string }[];
const toDevanagari = async (request: { contents: unknown }) =>
  reply(JSON.stringify({ translations: linesIn(request).map((l) => ({ id: l.id, translatedText: `देव ${l.text}` })) }));

beforeEach(() => {
  mocks.generate.mockReset();
  mocks.synthesize.mockReset();
  mocks.listVoices.mockReset();
  resetGeminiTtsStateForTests();
});
afterAll(async () => {
  await rm(cacheDir, { recursive: true, force: true });
});

describe('Hinglish speech script', () => {
  it('converts each distinct line once, and a retake only the line that changed', async () => {
    mocks.generate.mockImplementation(toDevanagari);
    const lines = [
      { id: 'a', text: 'kaise ho aap' },
      { id: 'b', text: 'main theek hoon' },
      { id: 'c', text: 'kaise ho aap' },
    ];
    expect(await vertexHinglishToSpeechScript(lines)).toEqual({ a: 'देव kaise ho aap', b: 'देव main theek hoon', c: 'देव kaise ho aap' });
    expect(mocks.generate).toHaveBeenCalledTimes(1);
    expect(linesIn(mocks.generate.mock.calls[0][0])).toHaveLength(2);

    const retake = await vertexHinglishToSpeechScript([...lines, { id: 'd', text: 'yeh line nayi hai' }]);
    expect(retake).toMatchObject({ a: 'देव kaise ho aap', d: 'देव yeh line nayi hai' });
    expect(mocks.generate).toHaveBeenCalledTimes(2);
    expect(linesIn(mocks.generate.mock.calls[1][0])).toEqual([{ id: 'd', text: 'yeh line nayi hai' }]);
  });

  it('sends a long video in parts, and keeps the parts that came back when one fails', async () => {
    mocks.generate.mockImplementation(async (request: { contents: unknown }) => {
      if (linesIn(request).some((l) => l.text === 'long video line 200')) throw new Error('400 INVALID_ARGUMENT: bad answer');
      return toDevanagari(request);
    });
    const lines = Array.from({ length: 320 }, (_, i) => ({ id: `l${i}`, text: `long video line ${i}` }));
    const converted = await vertexHinglishToSpeechScript(lines);
    expect(mocks.generate).toHaveBeenCalledTimes(3);
    expect(mocks.generate.mock.calls.every(([request]) => linesIn(request).length <= 150)).toBe(true);
    // The failed part's lines are voiced as written; the others keep their conversion.
    expect(Object.keys(converted)).toHaveLength(170);
    expect(converted.l0).toBe('देव long video line 0');
    expect(converted.l200).toBeUndefined();
  });

  it('still fails when no line could be converted', async () => {
    mocks.generate.mockRejectedValue(new Error('400 INVALID_ARGUMENT: refused'));
    await expect(vertexHinglishToSpeechScript([{ id: 'x', text: 'koi bhi line' }])).rejects.toThrow('refused');
  });
});

describe('condensing a line', () => {
  it('asks once per line and slot, and remembers when no shorter line fit', async () => {
    mocks.generate.mockResolvedValue(reply(JSON.stringify({ text: 'छोटी पंक्ति' })));
    const ask = (text: string, target = 2) => vertexCondenseLine(text, 'hi', 'Hindi', target, 3);
    expect(await ask('यह एक बहुत लंबी पंक्ति है जो समय में नहीं आती')).toBe('छोटी पंक्ति');
    expect(await ask('यह एक बहुत लंबी पंक्ति है जो समय में नहीं आती')).toBe('छोटी पंक्ति');
    expect(mocks.generate).toHaveBeenCalledTimes(1);

    // An answer no shorter than the line is rejected, and the line is not asked about again.
    mocks.generate.mockResolvedValue(reply(JSON.stringify({ text: 'यह दूसरी पंक्ति भी उतनी ही लंबी है बल्कि और भी लंबी' })));
    expect(await ask('यह दूसरी पंक्ति भी लंबी है')).toBeNull();
    expect(await ask('यह दूसरी पंक्ति भी लंबी है')).toBeNull();
    expect(mocks.generate).toHaveBeenCalledTimes(2);

    // A different slot is a different question.
    await ask('यह दूसरी पंक्ति भी लंबी है', 1.5);
    expect(mocks.generate).toHaveBeenCalledTimes(3);
  });
});

describe('AI review', () => {
  const idsIn = (request: { contents: { parts: { text?: string }[] }[] }) =>
    request.contents[0].parts.map((p) => /^Line "([^"]+)"/.exec(p.text ?? '')?.[1]).filter((id): id is string => Boolean(id));

  it('only sends takes the reviewer has not heard', async () => {
    mocks.generate.mockImplementation(async (request) =>
      reply(JSON.stringify({ lines: idsIn(request).map((id) => (id === 'r2' ? { id, ok: false, problem: 'garbled', note: 'cut off' } : { id, ok: true })) }))
    );
    const take = (bytes: string) => Buffer.from(`RIFF-${bytes}`);
    const lines = [
      { id: 'r1', script: 'एक', original: take('o1'), dubbed: take('d1') },
      { id: 'r2', script: 'दो', original: take('o2'), dubbed: take('d2') },
    ];
    const first = await reviewDubbedLines(lines, 'Hindi');
    expect(first.get('r2')).toMatchObject({ ok: false, problem: 'garbled' });
    expect(mocks.generate).toHaveBeenCalledTimes(1);

    // The same takes again, as in a retake of some other line: the same verdicts, with nothing sent.
    expect(await reviewDubbedLines(lines, 'Hindi')).toEqual(first);
    expect(mocks.generate).toHaveBeenCalledTimes(1);

    // A new take of a line is heard afresh.
    await reviewDubbedLines([{ ...lines[1], dubbed: take('d2-retake') }], 'Hindi');
    expect(mocks.generate).toHaveBeenCalledTimes(2);
  });
});

describe('voice cache', () => {
  const tone = pcmToWav(Buffer.from(Int16Array.from({ length: 4800 }, (_, i) => Math.round(Math.sin(i / 4) * 9000)).buffer), 24000);

  it('reuses the take Chirp 3 HD made while Gemini was out of quota instead of buying the line again', async () => {
    mocks.listVoices.mockResolvedValue([{ voices: [{ name: 'hi-IN-Chirp3-HD-Kore', languageCodes: ['hi-IN'], ssmlGender: 'FEMALE' }] }]);
    mocks.synthesize.mockImplementation(async (request: { voice: { modelName?: string } }) => {
      if (request.voice.modelName) throw Object.assign(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded'), { code: 8 });
      return [{ audioContent: tone }];
    });
    const voice = VOICES.find((v) => v.engine === 'gemini-2.5-flash')!;
    const voiceLine = () => routeSynthesizeSpeech('नमस्ते दोस्तों, स्वागत है', voice, 'hi', 'auto', { engines: ['gemini-2.5-flash'], style: 'calm' });

    expect(await voiceLine()).toMatchObject({ engine: 'chirp', fromCache: false });
    // By the retake Gemini has quota again; the unchanged line still keeps the take it was rendered with.
    resetGeminiTtsStateForTests();
    mocks.synthesize.mockClear();
    expect(await voiceLine()).toMatchObject({ engine: 'chirp', fromCache: true });
    expect(mocks.synthesize).not.toHaveBeenCalled();
  });
});
