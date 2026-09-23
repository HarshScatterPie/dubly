import { GoogleGenAI } from '@google/genai';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env } from './env';
import { gcpServiceAccountPath, hasCredentialFile } from './credentials';
import { buildTranslationPrompt, parseTranslationResponse, type TranslatableSegment } from './translatePrompt';
import { probeMedia, splitAudioIntoChunks, extractAudioClip } from './ffmpeg';
import { logGeminiCallCost } from './costMeter';

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

let client: GoogleGenAI | null = null;

export function isVertexConfigured(): boolean {
  return Boolean(env.vertexProjectId) && hasCredentialFile('gcp-service-account.json');
}

function getClient(): GoogleGenAI {
  if (!client) {
    if (!isVertexConfigured()) {
      throw new Error('Vertex AI is not configured (missing VERTEX_PROJECT_ID or gcp-service-account.json)');
    }
    client = new GoogleGenAI({
      vertexai: true,
      project: env.vertexProjectId,
      location: env.vertexGeminiLocation,
      googleAuthOptions: { keyFile: gcpServiceAccountPath },
    });
  }
  return client;
}

/**
 * With Sarvam/OpenAI gone, Vertex is the only STT/translation engine — a transient blip
 * (a 503, a dropped connection) now fails the whole analyze/translate step instead of
 * quietly falling through to another provider. Retrying the handful of error shapes that
 * are genuinely transient buys back most of that lost resilience.
 */
function isTransientError(err: unknown): boolean {
  const candidate = err as { status?: number; code?: string; message?: string };
  if (candidate?.status === 429 || candidate?.status === 500 || candidate?.status === 503) return true;
  if (candidate?.code === 'ECONNRESET' || candidate?.code === 'ETIMEDOUT' || candidate?.code === 'ECONNREFUSED') return true;
  return /RESOURCE_EXHAUSTED|UNAVAILABLE|INTERNAL|Quota exceeded|rate limit|too many requests|ECONNRESET|ETIMEDOUT|fetch failed/i.test(
    String(candidate?.message ?? err)
  );
}

const RETRY_BACKOFF_MS = [1000, 3000, 8000];

async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= RETRY_BACKOFF_MS.length || !isTransientError(err)) throw err;
      const waitMs = RETRY_BACKOFF_MS[attempt];
      console.warn(`[vertexClient] ${label} failed (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1}), retrying in ${waitMs}ms`, err);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/**
 * Gemini has no real forced-alignment / word-level timestamp capability for audio, so
 * for word timing (needed for karaoke-style captions) we approximate: distribute the
 * segment's [start, end] window across its words proportionally to word length, which
 * is a standard fallback technique when a real ASR word-aligner isn't available. It
 * won't be frame-accurate, but it tracks natural speech pacing reasonably well.
 */
function estimateWordTimings(text: string, start: number, end: number): RawSttWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const duration = Math.max(0.1, end - start);
  const totalChars = words.reduce((sum, w) => sum + w.length, 0) || words.length;

  let cursor = start;
  return words.map((w) => {
    const share = (Math.max(1, w.length) / totalChars) * duration;
    const wordStart = cursor;
    const wordEnd = Math.min(end, cursor + share);
    cursor = wordEnd;
    return { text: w, start: wordStart, end: wordEnd };
  });
}

export async function vertexTranslateSegments(
  segments: TranslatableSegment[],
  targetLanguageName: string,
  style: string,
  adaptExpressions: boolean
): Promise<Record<string, string>> {
  const ai = getClient();
  const prompt = buildTranslationPrompt(segments, targetLanguageName, style, adaptExpressions);

  const response = await withRetry('translation', () =>
    ai.models.generateContent({
      model: env.geminiTranslateModel,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.4,
      },
    })
  );
  logGeminiCallCost('translate', env.geminiTranslateModel, response.usageMetadata);

  const text = response.text;
  if (!text) {
    throw new Error('Vertex AI (Gemini) returned an empty translation response');
  }
  return parseTranslationResponse(text);
}

export interface SpeakerReference {
  label: string;
  /** Base64 16kHz mono WAV, a couple of seconds of that speaker's voice alone. */
  audioBase64: string;
}

/**
 * Gemini's multimodal audio understanding, used for speech-to-text. Handles
 * arbitrary-length audio (chunked below) in one model, with no separate
 * synchronous-call duration cap to work around.
 *
 * `speakerReferences` carries short voice samples of speakers already identified in
 * earlier chunks of the same recording, so a multi-speaker video that had to be split
 * (see VERTEX_MAX_CHUNK_SECONDS) keeps consistent "Speaker 1"/"Speaker 2" labels across
 * chunk boundaries instead of each chunk numbering its speakers from scratch — see
 * vertexTranscribe below, which is what actually builds and threads this list through.
 */
async function vertexTranscribeSingle(filePath: string, speakerReferences: SpeakerReference[] = []): Promise<RawSttResult> {
  const ai = getClient();
  const audioBuffer = await readFile(filePath);

  // Speaker labelling is folded into this same request on purpose. It used to be a second
  // pass that re-uploaded the identical audio to Gemini, which doubled the (audio-token
  // priced) cost of every transcription for information the model can just as easily
  // return the first time.
  const basePrompt = `Transcribe the spoken audio verbatim, breaking it into natural phrase/sentence segments with their timestamps.
Also identify how many distinct speakers are talking, using differences in voice (pitch, timbre, tone), and label every segment with who said it ("Speaker 1", "Speaker 2", ...). If only one person speaks throughout, label everything "Speaker 1".
Return ONLY a JSON object of the exact form:
{"language": "<detected spoken language, e.g. Hindi, English>", "segments": [{"start": <seconds, number>, "end": <seconds, number>, "text": "<verbatim text>", "speaker": "Speaker 1"}]}
Transcribe ONLY audible speech. Silence, music, breathing, applause and background noise must produce no segment at all — do not fill them with filler words.
Never repeat the same short phrase across consecutive segments; if you find yourself about to emit the same text again, emit nothing instead. Segments must advance through the audio: each start must be greater than or equal to the previous segment's end.
No commentary, no markdown fences. If there is no speech, return {"language": "unknown", "segments": []}.`;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];

  if (speakerReferences.length > 0) {
    parts.push({
      text: `This audio is a later part of a longer recording. Below are short reference clips of speakers already identified earlier, each immediately followed by its labeled sample. Use them to keep speaker labels consistent: if a voice in the main audio matches one of these references, reuse its exact label; only assign a new label ("Speaker ${
        speakerReferences.length + 1
      }", ...) to a voice that matches none of them.`,
    });
    for (const ref of speakerReferences) {
      parts.push({ text: `Reference sample for "${ref.label}":` });
      parts.push({ inlineData: { mimeType: 'audio/wav', data: ref.audioBase64 } });
    }
    parts.push({ text: `Now transcribe this next audio (the actual recording to transcribe, not a reference):\n\n${basePrompt}` });
  } else {
    parts.push({ text: basePrompt });
  }
  parts.push({ inlineData: { mimeType: 'audio/wav', data: audioBuffer.toString('base64') } });

  const response = await withRetry('transcription', () =>
    ai.models.generateContent({
      model: env.geminiSttModel,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 8192 },
    })
  );
  logGeminiCallCost('transcribe', env.geminiSttModel, response.usageMetadata);

  const text = response.text;
  if (!text) {
    throw new Error('Vertex AI (Gemini) returned an empty transcription response');
  }

  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');

  let parsed: { language?: string; segments?: Array<{ start: number; end: number; text: string; speaker?: string }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Vertex AI (Gemini) returned non-JSON transcription response: ${(err as Error).message}`);
  }

  const segments: RawSttSegment[] = (parsed.segments || []).map((s) => ({
    start: Number(s.start) || 0,
    end: Number(s.end) || 0,
    text: String(s.text || '').trim(),
    confidence: 0.9,
    speaker: typeof s.speaker === 'string' && s.speaker.trim() ? s.speaker.trim() : undefined,
    words: estimateWordTimings(String(s.text || '').trim(), Number(s.start) || 0, Number(s.end) || 0),
  }));

  return {
    text: segments.map((s) => s.text).join(' '),
    language: parsed.language || 'unknown',
    segments,
  };
}

// Gemini's inline-audio transcription silently truncates to only the first several
// seconds of long clips instead of erroring (confirmed empirically — a 113s clip came
// back as a single ~7s segment even with maxOutputTokens raised). Chunking sidesteps
// whatever the underlying limit is.
const VERTEX_MAX_CHUNK_SECONDS = 28;

// Bounds on the voice-reference carry-over between chunks (see vertexTranscribeSingle):
// enough speakers for the vast majority of real dub sources without letting prompt size
// (and audio-token cost) grow unbounded on a large cast, and a floor on sample length so
// a reference clip is actually long enough to carry a voice's identity.
const MAX_SPEAKER_REFERENCES = 4;
const REFERENCE_CLIP_MAX_SECONDS = 2.5;
const REFERENCE_CLIP_MIN_SECONDS = 0.6;

/**
 * Pulls a short voice sample for each speaker in `segments` not already in `known`,
 * cut from this chunk's own audio at that speaker's longest line (the most reliable
 * single sample available). Mutates `known` in place; stops once the cap is reached.
 */
async function captureSpeakerReferences(
  chunkPath: string,
  segments: RawSttSegment[],
  known: Map<string, string>,
  refDir: string
): Promise<void> {
  if (known.size >= MAX_SPEAKER_REFERENCES) return;

  const longestBySpeaker = new Map<string, RawSttSegment>();
  for (const seg of segments) {
    if (!seg.speaker || known.has(seg.speaker)) continue;
    const existing = longestBySpeaker.get(seg.speaker);
    if (!existing || seg.end - seg.start > existing.end - existing.start) {
      longestBySpeaker.set(seg.speaker, seg);
    }
  }

  for (const [label, seg] of longestBySpeaker) {
    if (known.size >= MAX_SPEAKER_REFERENCES) break;
    const duration = seg.end - seg.start;
    if (duration < REFERENCE_CLIP_MIN_SECONDS) continue; // too short to reliably carry a voice

    const clipPath = path.join(refDir, `ref_${randomUUID()}.wav`);
    try {
      await extractAudioClip(chunkPath, seg.start, Math.min(REFERENCE_CLIP_MAX_SECONDS, duration), clipPath);
      known.set(label, (await readFile(clipPath)).toString('base64'));
    } catch (err) {
      console.error(`[vertexClient] failed to capture a voice reference for ${label}`, err);
    } finally {
      await rm(clipPath, { force: true }).catch(() => undefined);
    }
  }
}

export async function vertexTranscribe(filePath: string): Promise<RawSttResult> {
  const probe = await probeMedia(filePath);
  if (probe.durationSeconds <= VERTEX_MAX_CHUNK_SECONDS) {
    return vertexTranscribeSingle(filePath);
  }

  const chunkDir = path.join(path.dirname(filePath), `vertex_chunks_${Date.now()}`);
  const refDir = path.join(chunkDir, 'refs');
  try {
    const chunkPaths = await splitAudioIntoChunks(filePath, VERTEX_MAX_CHUNK_SECONDS, chunkDir);
    await mkdir(refDir, { recursive: true });
    const allSegments: RawSttSegment[] = [];
    const allText: string[] = [];
    let detectedLanguage = 'unknown';

    // Carries a short voice sample per speaker forward from whichever chunk first
    // captured a good one, so chunk 2 (say) can recognize "this is the same voice as
    // Speaker 1 from chunk 1" instead of numbering its speakers from scratch — without
    // this, "Speaker 1" in every chunk is only meaningful *within* that chunk, which
    // silently scrambles voice assignment on any multi-speaker video long enough to chunk.
    const knownSpeakers = new Map<string, string>();

    let anySucceeded = false;
    // Chunks are not exactly VERTEX_MAX_CHUNK_SECONDS long (ffmpeg splits on packet
    // boundaries), so accumulate each chunk's real duration instead of assuming a fixed
    // stride, which would otherwise drift further out of sync the longer the video runs.
    let offset = 0;
    for (let i = 0; i < chunkPaths.length; i++) {
      try {
        const references = Array.from(knownSpeakers, ([label, audioBase64]) => ({ label, audioBase64 }));
        const result = await vertexTranscribeSingle(chunkPaths[i], references);
        anySucceeded = true;
        if (result.language && result.language !== 'unknown') detectedLanguage = result.language;
        if (result.text) allText.push(result.text);
        for (const seg of result.segments) {
          allSegments.push({
            start: seg.start + offset,
            end: seg.end + offset,
            text: seg.text,
            confidence: seg.confidence,
            speaker: seg.speaker,
            words: seg.words?.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })),
          });
        }
        await captureSpeakerReferences(chunkPaths[i], result.segments, knownSpeakers, refDir);
      } catch (err) {
        // One bad chunk (e.g. a malformed JSON response) shouldn't sink the whole
        // transcript — skip it and keep the segments we did get.
        console.error(`[vertexClient] chunk ${i} transcription failed, skipping`, err);
      }
      offset += (await probeMedia(chunkPaths[i])).durationSeconds;
    }

    if (!anySucceeded) {
      throw new Error('Vertex AI (Gemini) failed to transcribe any audio chunk');
    }
    return { text: allText.join(' '), language: detectedLanguage, segments: allSegments };
  } finally {
    await rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
  }
}


// Gemini's `gemini-2.5-flash-preview-tts` synthesis previously lived here. It was replaced
// by Google Cloud TTS (see googleTtsClient.ts): the preview model capped requests per
// minute per project irrespective of billing, which a multi-segment dub exhausts in a
// single render.
