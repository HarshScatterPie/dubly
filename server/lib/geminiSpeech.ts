import { GoogleGenAI, Modality } from '@google/genai';
import { env } from './env';
import { gcpServiceAccountPath, hasGoogleCredentials, useAdc } from './credentials';
import { isPerformanceTag, type PerformanceTag } from './performance';
import { pcmToWav } from './audioUtils';

/**
 * Gemini 3.8 Flash and Flash-Lite TTS. Cloud TTS does not serve 3.8 yet, so these go
 * through the Gemini API instead, on one of two routes:
 *
 * - With GEMINI_API_KEY: the Developer API's Interactions endpoint, as Google documents 3.8 TTS.
 * - Without: Vertex AI on the same service account as everything else, through generateContent.
 *   Checked 2026-09-29: Vertex lists both 3.8 TTS models but does not serve them yet. Its
 *   Interactions endpoint answers "Unsupported model interaction" and generateContent answers
 *   404 in every region tried, so until that changes production needs GEMINI_API_KEY.
 *
 * The model detects the language from the text, which is what lets one voice speak every
 * Indian language and dialect (Bhojpuri, Maithili, Santali...) without a locale per voice.
 */
let client: GoogleGenAI | null = null;

export function isGeminiSpeechConfigured(): boolean {
  return Boolean(env.geminiApiKey) || (Boolean(env.vertexProjectId) && hasGoogleCredentials());
}

function getClient(): GoogleGenAI {
  if (!client) {
    if (!isGeminiSpeechConfigured()) throw new Error('Gemini 3.8 voices are not configured (set GEMINI_API_KEY, or VERTEX_PROJECT_ID with Google credentials)');
    client = env.geminiApiKey
      ? new GoogleGenAI({ apiKey: env.geminiApiKey })
      : new GoogleGenAI({
          vertexai: true,
          project: env.vertexProjectId,
          location: env.vertexGeminiLocation,
          googleAuthOptions: useAdc ? {} : { keyFile: gcpServiceAccountPath },
        });
  }
  return client;
}

// 3.8 performs a few sounds as inline tags (<sigh>, <pause>); the rest of ours become part of the line's delivery.
const INLINE_TAG: Partial<Record<PerformanceTag, string>> = { sigh: '<sigh>', 'short pause': '<pause>', 'medium pause': '<pause>', 'long pause': '<pause>' };
const TAG_DELIVERY: Partial<Record<PerformanceTag, string>> = { laughing: 'laughing', whispering: 'whispering', shouting: 'shouting', sarcasm: 'sarcastic', uhm: 'hesitant' };

/** Rewrites our [tag] markup into what 3.8 voices perform, so no tag is ever read aloud. */
export function toGeminiSpeechInput(text: string, style: string): { text: string; style: string } {
  const delivery: string[] = [];
  const spoken = text
    .replace(/\[([^\]\n]{1,40})\]/g, (whole, inner: string) => {
      if (!isPerformanceTag(inner)) return whole;
      const tag = inner.trim().toLowerCase().replace(/\s+/g, ' ') as PerformanceTag;
      const as = TAG_DELIVERY[tag];
      if (as && !delivery.includes(as)) delivery.push(as);
      return INLINE_TAG[tag] ? ` ${INLINE_TAG[tag]} ` : ' ';
    })
    .replace(/\s+([,.!?।॥])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const extra = delivery.length ? `Deliver it ${delivery.join(', ')} where marked in the original.` : '';
  return { text: spoken, style: [style, extra].filter(Boolean).join(' ') };
}

export async function geminiSpeechSynthesize(model: string, text: string, voiceName: string, style: string): Promise<Buffer> {
  const input = toGeminiSpeechInput(text, style);
  return env.geminiApiKey ? interactionsSynthesize(model, input, voiceName) : generateContentSynthesize(model, input, voiceName);
}

// Raw 16-bit PCM is wrapped so every caller gets a WAV.
function asWav(bytes: Buffer, sampleRate: number, channels = 1): Buffer {
  return bytes.toString('ascii', 0, 4) === 'RIFF' ? bytes : pcmToWav(bytes, sampleRate, channels);
}

// The Developer API, as Google documents 3.8 TTS: the direction rides on the text as a `speech_metadata` annotation.
async function interactionsSynthesize(model: string, input: { text: string; style: string }, voiceName: string): Promise<Buffer> {
  // `speech_metadata` annotations postdate the SDK's types, so the text block is built untyped.
  const content = { type: 'text', text: input.text, ...(input.style ? { annotations: [{ type: 'speech_metadata', style: input.style }] } : {}) };
  const interaction = await getClient().interactions.create({
    model,
    input: [{ type: 'user_input', content: [content] }],
    response_format: { type: 'audio' },
    generation_config: { speech_config: [{ voice: voiceName }] },
  } as unknown as Parameters<GoogleGenAI['interactions']['create']>[0]);
  const audio = (interaction as { output_audio?: { data?: string; sample_rate?: number; channels?: number } }).output_audio;
  if (!audio?.data) throw new Error(`${model} returned no audio for voice ${voiceName}`);
  // Unary requests return a WAV file.
  return asWav(Buffer.from(audio.data, 'base64'), audio.sample_rate || 24000, audio.channels || 1);
}

/**
 * The prompt for generateContent, which has no separate field for direction: Google's TTS
 * prompting layout, where only the transcript is spoken and the notes above it steer how.
 */
export function directedPrompt(input: { text: string; style: string }): string {
  return input.style ? `### DIRECTOR'S NOTES\n${input.style}\n\n#### TRANSCRIPT\n${input.text}` : input.text;
}

// Vertex AI: the TTS models answer generateContent with raw 16-bit PCM (mime type "audio/L16;codec=pcm;rate=24000").
async function generateContentSynthesize(model: string, input: { text: string; style: string }, voiceName: string): Promise<Buffer> {
  const response = await getClient().models.generateContent({
    model,
    contents: [{ role: 'user', parts: [{ text: directedPrompt(input) }] }],
    config: { responseModalities: [Modality.AUDIO], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
  });
  const inline = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData;
  if (!inline?.data) throw new Error(`${model} returned no audio for voice ${voiceName} (finish reason ${response.candidates?.[0]?.finishReason ?? 'unknown'})`);
  const rate = Number(/rate=(\d+)/i.exec(inline.mimeType ?? '')?.[1]) || 24000;
  return asWav(Buffer.from(inline.data, 'base64'), rate);
}
