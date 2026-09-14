import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { env } from './env';
import { probeMedia, splitAudioIntoChunks } from './ffmpeg';
import type { RawSttResult, RawSttSegment, RawSttWord } from './openaiClient';

// A whole individual word is not a usable translation/TTS unit (word-by-word translation
// loses context and word-by-word TTS sounds robotic) — group Sarvam's real per-word
// timestamps into natural sentence/phrase segments instead, splitting on sentence-ending
// punctuation or a pause longer than this between two consecutive words.
const SENTENCE_PAUSE_GAP_SECONDS = 0.6;

function groupWordsIntoSegments(words: RawSttWord[]): RawSttSegment[] {
  if (words.length === 0) return [];
  const segments: RawSttSegment[] = [];
  let current: RawSttWord[] = [];

  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.text).join(' ').replace(/\s+([,.!?;:])/g, '$1'),
      confidence: 0.95,
      words: current,
    });
    current = [];
  };

  for (let i = 0; i < words.length; i++) {
    current.push(words[i]);
    const isSentenceEnd = /[.!?]$/.test(words[i].text.trim());
    const next = words[i + 1];
    const pauseBeforeNext = next ? next.start - words[i].end : Infinity;
    if (isSentenceEnd || pauseBeforeNext > SENTENCE_PAUSE_GAP_SECONDS) {
      flush();
    }
  }
  flush();
  return segments;
}

const BASE_URL = 'https://api.sarvam.ai';

export function isSarvamConfigured(): boolean {
  return Boolean(env.sarvamApiKey);
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  if (!env.sarvamApiKey) {
    throw new Error('SARVAM_API_KEY is not configured');
  }
  return { 'api-subscription-key': env.sarvamApiKey, ...extra };
}

export async function sarvamTranscribe(filePath: string, languageCode: string): Promise<RawSttResult> {
  const fileBuffer = await readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([fileBuffer]), path.basename(filePath));
  form.append('model', 'saaras:v3');
  form.append('language_code', languageCode || 'unknown');
  form.append('mode', 'transcribe');
  form.append('with_timestamps', 'true');

  const res = await fetch(`${BASE_URL}/speech-to-text`, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  });

  if (!res.ok) {
    throw new Error(`Sarvam STT failed (${res.status}): ${await res.text()}`);
  }

  const data = (await res.json()) as {
    transcript: string;
    language_code: string | null;
    language_probability?: number;
    timestamps?: {
      words?: string[];
      start_time_seconds?: number[];
      end_time_seconds?: number[];
    };
  };

  const chunks = data.timestamps?.words;
  const starts = data.timestamps?.start_time_seconds;
  const ends = data.timestamps?.end_time_seconds;

  let segments: RawSttSegment[];
  if (chunks && starts && ends && chunks.length > 0) {
    const words: RawSttWord[] = chunks.map((text, i) => ({
      text: text.trim(),
      start: starts[i] ?? 0,
      end: ends[i] ?? (starts[i] ?? 0) + 0.3,
    }));
    segments = groupWordsIntoSegments(words);
  } else {
    // No timestamp breakdown returned — fall back to one segment spanning the transcript.
    segments = [{ start: 0, end: 0, text: data.transcript.trim(), confidence: data.language_probability ?? 0.95 }];
  }

  return { text: data.transcript, language: data.language_code || languageCode || 'unknown', segments };
}

// Sarvam's synchronous /speech-to-text endpoint hard-caps audio at 30s ("use the batch
// API for longer audio files"); most real videos exceed that. Rather than integrate the
// separate multi-step batch job API, split into chunks under the cap, transcribe each,
// and re-offset the timestamps to stitch a continuous transcript.
const SARVAM_MAX_SYNC_SECONDS = 28;

export async function sarvamTranscribeChunked(filePath: string, languageCode: string): Promise<RawSttResult> {
  const probe = await probeMedia(filePath);
  if (probe.durationSeconds <= SARVAM_MAX_SYNC_SECONDS) {
    return sarvamTranscribe(filePath, languageCode);
  }

  const chunkDir = path.join(path.dirname(filePath), `sarvam_chunks_${Date.now()}`);
  try {
    const chunkPaths = await splitAudioIntoChunks(filePath, SARVAM_MAX_SYNC_SECONDS, chunkDir);
    const allSegments: RawSttSegment[] = [];
    const allText: string[] = [];
    let detectedLanguage = languageCode;

    // ffmpeg's segment muxer splits on packet boundaries, so chunks are NOT exactly
    // SARVAM_MAX_SYNC_SECONDS long (measured ~28.03s each) — assuming a fixed offset
    // accumulates real drift across a long video, so track each chunk's true duration.
    let offset = 0;
    for (let i = 0; i < chunkPaths.length; i++) {
      const result = await sarvamTranscribe(chunkPaths[i], languageCode);
      if (result.language && result.language !== 'unknown') detectedLanguage = result.language;
      if (result.text) allText.push(result.text);
      for (const seg of result.segments) {
        allSegments.push({
          start: seg.start + offset,
          end: seg.end + offset,
          text: seg.text,
          confidence: seg.confidence,
          words: seg.words?.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })),
        });
      }
      offset += (await probeMedia(chunkPaths[i])).durationSeconds;
    }

    return { text: allText.join(' '), language: detectedLanguage, segments: allSegments };
  } finally {
    await rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

const TRANSLATE_MODE_MAP: Record<string, 'formal' | 'modern-colloquial' | 'classic-colloquial' | 'code-mixed'> = {
  natural: 'modern-colloquial',
  literal: 'formal',
  professional: 'formal',
  casual: 'code-mixed',
  marketing: 'modern-colloquial',
};

export async function sarvamTranslate(
  text: string,
  targetLanguageCode: string,
  style: string
): Promise<string> {
  const res = await fetch(`${BASE_URL}/translate`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      input: text,
      source_language_code: 'auto',
      target_language_code: targetLanguageCode,
      mode: TRANSLATE_MODE_MAP[style] || 'modern-colloquial',
      model: 'mayura:v1',
    }),
  });

  if (!res.ok) {
    throw new Error(`Sarvam translate failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { translated_text: string };
  return data.translated_text;
}

export async function sarvamTranslateSegments(
  segments: { id: string; text: string }[],
  targetLanguageCode: string,
  style: string
): Promise<Record<string, string>> {
  // Sarvam's translate endpoint is single-string, not batch — run with limited concurrency.
  const map: Record<string, string> = {};
  const BATCH = 4;
  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map((seg) => sarvamTranslate(seg.text, targetLanguageCode, style))
    );
    batch.forEach((seg, idx) => {
      map[seg.id] = results[idx];
    });
  }
  return map;
}

export async function sarvamSynthesizeSpeech(
  text: string,
  speaker: string,
  languageCode: string
): Promise<Buffer> {
  const res = await fetch(`${BASE_URL}/text-to-speech`, {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      text,
      language_code: languageCode,
      // v2 only accepts a small fixed roster (anushka, abhilash, manisha, vidya, arya,
      // karun, hitesh) — v3 supports the full named-speaker catalog our voice personas
      // map onto (confirmed live against the API).
      model: 'bulbul:v3',
      speaker,
      output_audio_codec: 'wav',
      speech_sample_rate: 24000,
      enable_preprocessing: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Sarvam TTS failed (${res.status}): ${await res.text()}`);
  }
  const data = (await res.json()) as { audios: string[] };
  if (!data.audios?.[0]) {
    throw new Error('Sarvam TTS returned no audio');
  }
  return Buffer.from(data.audios[0], 'base64');
}
