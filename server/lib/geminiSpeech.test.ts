import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ generateContent: vi.fn(), createInteraction: vi.fn(), apiKey: { value: '' } }));

vi.mock('./credentials', () => ({ hasGoogleCredentials: () => true, useAdc: true, gcpServiceAccountPath: '' }));
vi.mock('./env', async (importOriginal) => {
  const original = await importOriginal<typeof import('./env')>();
  return {
    env: Object.defineProperty({ ...original.env, vertexProjectId: 'demo-project' }, 'geminiApiKey', { get: () => mocks.apiKey.value }),
  };
});
vi.mock('@google/genai', () => ({
  Modality: { AUDIO: 'AUDIO' },
  GoogleGenAI: class {
    models = { generateContent: mocks.generateContent };
    interactions = { create: mocks.createInteraction };
  },
}));

import { directedPrompt, geminiSpeechSynthesize, toGeminiSpeechInput } from './geminiSpeech';

const pcm = Buffer.alloc(48000); // one second of 16-bit mono at 24 kHz

beforeEach(() => {
  mocks.apiKey.value = '';
  mocks.generateContent.mockReset();
  mocks.createInteraction.mockReset();
});

describe('toGeminiSpeechInput', () => {
  it('leaves an untagged line and its direction as they are', () => {
    expect(toGeminiSpeechInput('नमस्ते दोस्तों!', 'Speak warmly.')).toEqual({ text: 'नमस्ते दोस्तों!', style: 'Speak warmly.' });
  });

  it('turns sighs and pauses into inline tags, and other sounds into delivery, so no tag is read aloud', () => {
    const { text, style } = toGeminiSpeechInput('[sigh] अच्छा [short pause] ठीक है [laughing]!', 'Speak warmly.');
    expect(text).toBe('<sigh> अच्छा <pause> ठीक है!');
    expect(text).not.toMatch(/\[/);
    expect(style).toBe('Speak warmly. Deliver it laughing where marked in the original.');
  });

  it('keeps bracketed text that is not a performance tag', () => {
    expect(toGeminiSpeechInput('Chapter [one] begins', '').text).toBe('Chapter [one] begins');
  });
});

describe('geminiSpeechSynthesize', () => {
  it('goes through generateContent on Vertex, with the direction as notes above the transcript', async () => {
    mocks.generateContent.mockResolvedValue({
      candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;codec=pcm;rate=24000', data: pcm.toString('base64') } }] } }],
    });
    const wav = await geminiSpeechSynthesize('gemini-3.8-flash-lite-tts', 'नमस्ते', 'Kore', 'Speak warmly.');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.length).toBe(44 + pcm.length);
    const [request] = mocks.generateContent.mock.calls[0];
    expect(request.model).toBe('gemini-3.8-flash-lite-tts');
    expect(request.contents[0].parts[0].text).toBe("### DIRECTOR'S NOTES\nSpeak warmly.\n\n#### TRANSCRIPT\nनमस्ते");
    expect(request.config.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('Kore');
    expect(mocks.createInteraction).not.toHaveBeenCalled();
  });

  it('sends a line with no direction as the bare transcript', () => {
    expect(directedPrompt({ text: 'नमस्ते', style: '' })).toBe('नमस्ते');
  });

  it('fails loudly when Vertex answers without audio', async () => {
    mocks.generateContent.mockResolvedValue({ candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }] });
    await expect(geminiSpeechSynthesize('gemini-3.8-flash-lite-tts', 'नमस्ते', 'Kore', '')).rejects.toThrow(/no audio.*SAFETY/);
  });

  it('goes through the Interactions endpoint with a Gemini API key, the direction as speech_metadata', async () => {
    mocks.apiKey.value = 'test-key';
    mocks.createInteraction.mockResolvedValue({ output_audio: { data: pcm.toString('base64'), sample_rate: 24000 } });
    const wav = await geminiSpeechSynthesize('gemini-3.8-flash-tts', 'नमस्ते', 'Kore', 'Speak warmly.');
    expect(wav.toString('ascii', 0, 4)).toBe('RIFF');
    const [request] = mocks.createInteraction.mock.calls[0];
    expect(request.input[0].content[0]).toEqual({ type: 'text', text: 'नमस्ते', annotations: [{ type: 'speech_metadata', style: 'Speak warmly.' }] });
    expect(request.generation_config.speech_config).toEqual([{ voice: 'Kore' }]);
    expect(mocks.generateContent).not.toHaveBeenCalled();
  });
});
