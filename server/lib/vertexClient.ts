import { GoogleGenAI } from '@google/genai';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';
import { gcpServiceAccountPath, hasCredentialFile } from './credentials';
import { buildTranslationPrompt, parseTranslationResponse, type TranslatableSegment } from './translatePrompt';
import { probeMedia, splitAudioIntoChunks } from './ffmpeg';
import type { RawSttResult, RawSttSegment, RawSttWord } from './openaiClient';

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
      location: env.vertexLocation,
      googleAuthOptions: { keyFile: gcpServiceAccountPath },
    });
  }
  return client;
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

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0.4,
    },
  });

  const text = response.text;
  if (!text) {
    throw new Error('Vertex AI (Gemini) returned an empty translation response');
  }
  return parseTranslationResponse(text);
}

/**
 * Gemini's multimodal audio understanding as an STT fallback — unlike Sarvam's
 * synchronous endpoint (30s cap) this handles arbitrary-length audio in one call, so
 * it's a solid fallback for real-length videos when Sarvam can't take the whole file
 * and OpenAI Whisper isn't configured.
 */
async function vertexTranscribeSingle(filePath: string): Promise<RawSttResult> {
  const ai = getClient();
  const audioBuffer = await readFile(filePath);

  // Speaker labelling is folded into this same request on purpose. It used to be a second
  // pass that re-uploaded the identical audio to Gemini, which doubled the (audio-token
  // priced) cost of every transcription for information the model can just as easily
  // return the first time.
  const prompt = `Transcribe the spoken audio verbatim, breaking it into natural phrase/sentence segments with their timestamps.
Also identify how many distinct speakers are talking, using differences in voice (pitch, timbre, tone), and label every segment with who said it ("Speaker 1", "Speaker 2", ...). If only one person speaks throughout, label everything "Speaker 1".
Return ONLY a JSON object of the exact form:
{"language": "<detected spoken language, e.g. Hindi, English>", "segments": [{"start": <seconds, number>, "end": <seconds, number>, "text": "<verbatim text>", "speaker": "Speaker 1"}]}
Transcribe ONLY audible speech. Silence, music, breathing, applause and background noise must produce no segment at all — do not fill them with filler words.
Never repeat the same short phrase across consecutive segments; if you find yourself about to emit the same text again, emit nothing instead. Segments must advance through the audio: each start must be greater than or equal to the previous segment's end.
No commentary, no markdown fences. If there is no speech, return {"language": "unknown", "segments": []}.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, { inlineData: { mimeType: 'audio/wav', data: audioBuffer.toString('base64') } }],
      },
    ],
    config: { responseMimeType: 'application/json', temperature: 0.2, maxOutputTokens: 8192 },
  });

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
// whatever the underlying limit is, same approach as the Sarvam sync-call workaround.
const VERTEX_MAX_CHUNK_SECONDS = 28;

export async function vertexTranscribe(filePath: string): Promise<RawSttResult> {
  const probe = await probeMedia(filePath);
  if (probe.durationSeconds <= VERTEX_MAX_CHUNK_SECONDS) {
    return vertexTranscribeSingle(filePath);
  }

  const chunkDir = path.join(path.dirname(filePath), `vertex_chunks_${Date.now()}`);
  try {
    const chunkPaths = await splitAudioIntoChunks(filePath, VERTEX_MAX_CHUNK_SECONDS, chunkDir);
    const allSegments: RawSttSegment[] = [];
    const allText: string[] = [];
    let detectedLanguage = 'unknown';

    let anySucceeded = false;
    // Chunks are not exactly VERTEX_MAX_CHUNK_SECONDS long (ffmpeg splits on packet
    // boundaries), so accumulate each chunk's real duration instead of assuming a fixed
    // stride, which would otherwise drift further out of sync the longer the video runs.
    let offset = 0;
    for (let i = 0; i < chunkPaths.length; i++) {
      try {
        const result = await vertexTranscribeSingle(chunkPaths[i]);
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
