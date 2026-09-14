import OpenAI from 'openai';
import fs from 'node:fs';
import { env } from './env';
import { buildTranslationPrompt, parseTranslationResponse, type TranslatableSegment } from './translatePrompt';

let client: OpenAI | null = null;

export function isOpenAIConfigured(): boolean {
  return Boolean(env.openaiApiKey);
}

function getClient(): OpenAI {
  if (!client) {
    if (!env.openaiApiKey) {
      throw new Error('OPENAI_API_KEY is not configured');
    }
    client = new OpenAI({ apiKey: env.openaiApiKey });
  }
  return client;
}

export interface RawSttWord {
  text: string;
  start: number;
  end: number;
}

export interface RawSttSegment {
  start: number;
  end: number;
  text: string;
  confidence: number;
  words?: RawSttWord[];
  /** Set when the provider could label speakers as part of transcription, avoiding a separate diarization pass. */
  speaker?: string;
}

export interface RawSttResult {
  text: string;
  language: string;
  segments: RawSttSegment[];
}

export async function openaiTranscribe(filePath: string): Promise<RawSttResult> {
  const ai = getClient();
  const result = await ai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1',
    response_format: 'verbose_json',
    timestamp_granularities: ['word', 'segment'],
  });

  const verbose = result as unknown as {
    text: string;
    language: string;
    segments?: Array<{ start: number; end: number; text: string; avg_logprob: number }>;
    words?: Array<{ word: string; start: number; end: number }>;
  };

  const allWords = verbose.words || [];
  const segments: RawSttSegment[] = (verbose.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text.trim(),
    confidence: Math.max(0, Math.min(1, Math.exp(s.avg_logprob))),
    // Whisper returns one flat word list for the whole clip — assign each word to
    // whichever segment its midpoint falls within.
    words: allWords
      .filter((w) => {
        const mid = (w.start + w.end) / 2;
        return mid >= s.start && mid <= s.end;
      })
      .map((w) => ({ text: w.word.trim(), start: w.start, end: w.end })),
  }));

  return { text: verbose.text, language: verbose.language || 'unknown', segments };
}

export async function openaiTranslateSegments(
  segments: TranslatableSegment[],
  targetLanguageName: string,
  style: string,
  adaptExpressions: boolean
): Promise<Record<string, string>> {
  const ai = getClient();
  const prompt = buildTranslationPrompt(segments, targetLanguageName, style, adaptExpressions);

  const completion = await ai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0.4,
  });

  const text = completion.choices[0]?.message?.content;
  if (!text) {
    throw new Error('OpenAI returned an empty translation response');
  }
  return parseTranslationResponse(text);
}

export type OpenAIVoiceId =
  | 'alloy'
  | 'ash'
  | 'ballad'
  | 'coral'
  | 'echo'
  | 'fable'
  | 'onyx'
  | 'nova'
  | 'sage'
  | 'shimmer'
  | 'verse';

export async function openaiSynthesizeSpeech(text: string, voice: OpenAIVoiceId): Promise<Buffer> {
  const ai = getClient();
  const response = await ai.audio.speech.create({
    model: 'gpt-4o-mini-tts',
    voice,
    input: text,
    response_format: 'wav',
  });
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}
