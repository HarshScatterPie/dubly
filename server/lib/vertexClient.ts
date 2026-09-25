import { GoogleGenAI } from '@google/genai';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { env } from './env';
import { gcpServiceAccountPath, hasGoogleCredentials, useAdc } from './credentials';
import { buildTranslationPrompt, parseTranslationResponse, type TranslatableSegment, type TranslationContext } from './translatePrompt';
import { probeMedia, splitAudioIntoChunks, extractAudioClip } from './ffmpeg';
import { logGeminiCallCost } from './costMeter';
import { getScriptInstruction, isInExpectedScript, mapDetectedLanguageToAppCode } from './languageMeta';
import { log } from './log';
import { cleanDelivery } from './speechStyle';
import { glossaryInstruction, glossaryMisses, relevantEntries, withoutKeptTerms } from './glossary';
import type { GlossaryEntry, SpeakerProfile } from '../../src/types';
import { acceptHeardPerformance, sanitizePerformanceTags, stripPerformanceTags } from './performance';
import { mergeSpeakerProfiles } from './speakerProfiles';

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
  // How the line is said (e.g. "excited and fast"), heard in the same pass; steers the dubbed voice.
  delivery?: string;
  // The same words with heard laughs and sighs marked inline, when there were any.
  performance?: string;
}

export interface RawSttResult {
  text: string;
  language: string;
  segments: RawSttSegment[];
  // Speaker label -> gender and age as heard, merged across chunks.
  speakers?: Record<string, SpeakerProfile>;
}

let client: GoogleGenAI | null = null;

export function isVertexConfigured(): boolean {
  return Boolean(env.vertexProjectId) && hasGoogleCredentials();
}

function getClient(): GoogleGenAI {
  if (!client) {
    if (!isVertexConfigured()) {
      throw new Error('Vertex AI is not configured (set VERTEX_PROJECT_ID, and provide gcp-service-account.json or CREDENTIALS_MODE=adc)');
    }
    client = new GoogleGenAI({
      vertexai: true,
      project: env.vertexProjectId,
      location: env.vertexGeminiLocation,
      googleAuthOptions: useAdc ? {} : { keyFile: gcpServiceAccountPath },
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
  const started = Date.now();
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await fn();
      log.info('provider_call', { provider: 'vertex', operation: label, attempts: attempt + 1, durationMs: Date.now() - started });
      return result;
    } catch (err) {
      if (attempt >= RETRY_BACKOFF_MS.length || !isTransientError(err)) {
        log.error('provider_error', err, { provider: 'vertex', operation: label, attempts: attempt + 1, durationMs: Date.now() - started });
        throw err;
      }
      const waitMs = RETRY_BACKOFF_MS[attempt];
      log.warn('provider_retry', { provider: 'vertex', operation: label, attempt: attempt + 1, waitMs }, `[vertexClient] ${label} failed (attempt ${attempt + 1}/${RETRY_BACKOFF_MS.length + 1}), retrying in ${waitMs}ms: ${(err as Error)?.message}`);
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

async function requestTranslations(
  segments: TranslatableSegment[],
  targetLanguageName: string,
  style: string,
  adaptExpressions: boolean,
  scriptInstruction: string,
  glossaryText: string,
  context: TranslationContext
): Promise<Record<string, string>> {
  const ai = getClient();
  const prompt = buildTranslationPrompt(segments, targetLanguageName, style, adaptExpressions, scriptInstruction, glossaryText, context);

  const response = await withRetry('translation', () =>
    ai.models.generateContent({
      model: env.geminiTranslateModel,
      contents: prompt,
      // Low temperature keeps the translation faithful; creativity here is where invented content comes from.
      config: { responseMimeType: 'application/json', temperature: 0.2 },
    })
  );
  logGeminiCallCost('translate', env.geminiTranslateModel, response.usageMetadata);

  const text = response.text;
  if (!text) {
    throw new Error('Vertex AI (Gemini) returned an empty translation response');
  }
  return parseTranslationResponse(text);
}

export async function vertexTranslateSegments(
  segments: TranslatableSegment[],
  targetLanguageCode: string,
  targetLanguageName: string,
  style: string,
  adaptExpressions: boolean,
  glossary: GlossaryEntry[] = [],
  context: TranslationContext = {}
): Promise<Record<string, string>> {
  const scriptInstruction = getScriptInstruction(targetLanguageCode);
  // Only the terms these lines actually use, so a large glossary does not bloat every prompt.
  const terms = relevantEntries(glossary, segments.map((s) => s.text));
  const glossaryText = glossaryInstruction(terms, targetLanguageCode);
  const ask = async (lines: TranslatableSegment[]) => {
    const raw = await requestTranslations(lines, targetLanguageName, style, adaptExpressions, scriptInstruction, glossaryText, context);
    // A translation keeps the source's laughs and sighs but may not invent any.
    for (const s of lines) if (raw[s.id] !== undefined) raw[s.id] = sanitizePerformanceTags(raw[s.id], s.text);
    return raw;
  };
  const result = await ask(segments);

  // Lower is better: a wrong script outweighs any number of missed glossary terms.
  const problems = (source: string, text: string | undefined) =>
    !text?.trim()
      ? Infinity
      : (isInExpectedScript(withoutKeptTerms(stripPerformanceTags(text), terms), targetLanguageCode) ? 0 : 100) + glossaryMisses(source, text, terms, targetLanguageCode).length;

  // One targeted re-ask for lines that went missing, came back in the wrong script (e.g. romanized Hindi) or broke the glossary.
  const bad = segments.filter((s) => problems(s.text, result[s.id]) > 0);
  if (bad.length > 0) {
    console.warn(`[vertexClient] ${bad.length}/${segments.length} ${targetLanguageName} lines missing, in the wrong script or off-glossary, retrying them`);
    try {
      const retried = await ask(bad);
      for (const s of bad) {
        const candidate = retried[s.id]?.trim();
        if (candidate && problems(s.text, candidate) < problems(s.text, result[s.id])) result[s.id] = candidate;
      }
    } catch (err) {
      console.error('[vertexClient] translation retry failed, keeping first pass', err);
    }
  }
  return result;
}

// Rewrites romanized Hinglish into Devanagari (English words kept in Latin) purely for the TTS voice, which pronounces Devanagari far more reliably.
export async function vertexHinglishToSpeechScript(lines: { id: string; text: string }[]): Promise<Record<string, string>> {
  if (lines.length === 0) return {};
  const ai = getClient();
  const prompt = `Convert each romanized Hinglish line below into the form a Hindi text-to-speech voice reads best: write the Hindi words in Devanagari, keep genuine English words in Latin letters, and keep punctuation and bracketed tags such as [laughing] exactly as they are. Do not translate, add, drop or reorder any words — only change the script.
Return ONLY {"translations": [{"id": "<same id>", "translatedText": "<converted line>"}]}.

Lines:
${JSON.stringify(lines)}`;
  const response = await withRetry('hinglish-speech-script', () =>
    ai.models.generateContent({
      model: env.geminiTranslateModel,
      contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 0 },
    })
  );
  logGeminiCallCost('hinglish-speech-script', env.geminiTranslateModel, response.usageMetadata);
  const converted = response.text ? parseTranslationResponse(response.text) : {};
  for (const line of lines) if (converted[line.id] !== undefined) converted[line.id] = sanitizePerformanceTags(converted[line.id], line.text);
  return converted;
}

// Shortens one dubbed line so it can be spoken inside its on-screen slot without being rushed.
export async function vertexCondenseLine(
  text: string,
  targetLanguageCode: string,
  targetLanguageName: string,
  targetSeconds: number,
  currentSeconds: number,
  // Glossary renderings present in the line; a shortened line that drops one is rejected.
  protectedTerms: string[] = []
): Promise<string | null> {
  const ai = getClient();
  const keepRatio = Math.max(0.4, Math.min(0.95, targetSeconds / currentSeconds));
  const scriptInstruction = getScriptInstruction(targetLanguageCode);
  const mustKeep = protectedTerms.filter((term) => text.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
  const prompt = `This ${targetLanguageName} dubbing line takes ${currentSeconds.toFixed(1)}s to speak but must fit in ${targetSeconds.toFixed(1)}s.
Rewrite it to about ${Math.round(keepRatio * 100)}% of its current length while keeping the core meaning and tone. Drop filler and redundancy; do not add anything new. Keep bracketed tags such as [laughing] or [sigh] exactly as written.
${scriptInstruction}${mustKeep.length ? `
Keep these terms exactly as written: ${mustKeep.map((t) => JSON.stringify(t)).join(', ')}.` : ''}
Return ONLY {"text": "<shortened line>"}.

Line: ${JSON.stringify(text)}`;
  const response = await withRetry('condense', () =>
    ai.models.generateContent({
      model: env.geminiTranslateModel,
      contents: prompt,
      config: { responseMimeType: 'application/json', temperature: 0.2 },
    })
  );
  logGeminiCallCost('condense', env.geminiTranslateModel, response.usageMetadata);
  try {
    const parsed = JSON.parse((response.text || '').trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, ''));
    const shortened = typeof parsed?.text === 'string' ? sanitizePerformanceTags(parsed.text.trim(), text) : '';
    if (!shortened || shortened.length >= text.length || !isInExpectedScript(stripPerformanceTags(shortened), targetLanguageCode)) return null;
    if (mustKeep.some((term) => !shortened.toLocaleLowerCase().includes(term.toLocaleLowerCase()))) return null;
    return shortened;
  } catch {
    return null;
  }
}

export type VertexPart = { text: string } | { inlineData: { mimeType: string; data: string } };

// One multimodal request answered as JSON text, with the shared retries and cost logging; callers own the prompt and the parsing.
export async function vertexGenerateJson(model: string, parts: VertexPart[], operation: string, maxOutputTokens = 4096): Promise<string> {
  const ai = getClient();
  const response = await withRetry(operation, () =>
    ai.models.generateContent({
      model,
      contents: [{ role: 'user', parts }],
      config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens },
    })
  );
  logGeminiCallCost(operation, model, response.usageMetadata);
  return (response.text || '').trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/```\s*$/i, '');
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
async function vertexTranscribeSingle(
  filePath: string,
  speakerReferences: SpeakerReference[] = [],
  knownLanguage?: string,
  allowScriptRetry = true
): Promise<RawSttResult> {
  const ai = getClient();
  const audioBuffer = await readFile(filePath);

  // Earlier chunks already identified the language; pinning it stops a chunk flipping script mid-video.
  const languageLine = knownLanguage
    ? `The recording is in ${knownLanguage}. Transcribe it in ${knownLanguage}.`
    : 'First identify the spoken language.';

  // Speaker labelling is folded into this same request on purpose. It used to be a second
  // pass that re-uploaded the identical audio to Gemini, which doubled the (audio-token
  // priced) cost of every transcription for information the model can just as easily
  // return the first time.
  const basePrompt = `Transcribe the spoken audio verbatim, breaking it into natural phrase/sentence segments with their timestamps.
${languageLine}
SCRIPT RULE (critical): write the transcript in the NATIVE writing system of the spoken language — Telugu in Telugu script (తెలుగు), Hindi in Devanagari (हिन्दी), Tamil in Tamil script (தமிழ்), Bengali in Bengali script, Kannada in Kannada script, Malayalam in Malayalam script, Gujarati in Gujarati script, Punjabi in Gurmukhi, Marathi in Devanagari, Japanese in kanji/kana, and so on. NEVER romanize or transliterate a non-Latin-script language into English letters. English words spoken inside such a language are written in that language's script as pronounced; only brand names and acronyms may stay in Latin letters. Do NOT translate anything — write exactly what was said.
Also identify how many distinct speakers are talking, using differences in voice (pitch, timbre, tone), and label every segment with who said it ("Speaker 1", "Speaker 2", ...). If only one person speaks throughout, label everything "Speaker 1".
Describe every speaker once in "speakers": the gender their voice sounds ("male", "female", or "unknown" if you cannot tell) and their apparent age ("child", "young", "adult" or "senior"). The dub is voiced and translated from this, so do not guess: say "unknown" when unsure.
For every segment also describe its delivery in English, 2 to 6 words: the emotion, energy and pace you hear (e.g. "excited and fast", "calm and warm", "sarcastic", "whispering", "angry, shouting", "sad and slow"). Describe how it is said, not what is said.
If the speaker audibly laughs or sighs within a segment, also give "performance": exactly the same verbatim text with [laughing] or [sigh] inserted where it happens (e.g. "[laughing] That was brilliant!"). Use only those two tags, never change the words, and leave "performance" out when there is no laugh or sigh.
Return ONLY a JSON object of the exact form:
{"language": "<detected spoken language as its English name, e.g. Telugu, Hindi, English>", "speakers": [{"label": "Speaker 1", "gender": "male|female|unknown", "age": "child|young|adult|senior"}], "segments": [{"start": <seconds, number>, "end": <seconds, number>, "text": "<verbatim text>", "speaker": "Speaker 1", "delivery": "<2-6 words>", "performance": "<optional, only with a laugh or sigh>"}]}
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
      // Temperature 0: transcription has one right answer, and any sampling freedom is where filler loops come from.
      config: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 8192 },
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

  let parsed: {
    language?: string;
    speakers?: unknown;
    segments?: Array<{ start: number; end: number; text: string; speaker?: string; delivery?: string; performance?: unknown }>;
  };
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Vertex AI (Gemini) returned non-JSON transcription response: ${(err as Error).message}`);
  }

  const segments: RawSttSegment[] = (parsed.segments || []).map((s) => {
    const text = String(s.text || '').trim();
    const performance = acceptHeardPerformance(text, s.performance);
    return {
      start: Number(s.start) || 0,
      end: Number(s.end) || 0,
      text,
      confidence: 0.9,
      speaker: typeof s.speaker === 'string' && s.speaker.trim() ? s.speaker.trim() : undefined,
      delivery: cleanDelivery(s.delivery),
      ...(performance ? { performance } : {}),
      words: estimateWordTimings(text, Number(s.start) || 0, Number(s.end) || 0),
    };
  });
  const speakers = mergeSpeakerProfiles({}, parsed.speakers);

  const language = parsed.language || 'unknown';
  const joined = segments.map((s) => s.text).join(' ');
  const languageCode = mapDetectedLanguageToAppCode(language);
  if (allowScriptRetry && joined && !isInExpectedScript(joined, languageCode)) {
    console.warn(`[vertexClient] transcript came back romanized for ${language}, retrying in native script`);
    const retry = await vertexTranscribeSingle(filePath, speakerReferences, language, false);
    if (isInExpectedScript(retry.text, languageCode)) return retry;
  }

  return { text: joined, language, segments, speakers };
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

// Chunks sent to Gemini at once after the first; enough to cut wall time ~3x without tripping per-minute quotas.
const STT_PARALLEL_CHUNKS = 3;

export async function vertexTranscribe(
  filePath: string,
  // Called as each chunk finishes (with the language detected so far), so the UI shows real progress and callers can start dependent work early.
  onChunkDone?: (done: number, total: number, language: string) => void | Promise<void>
): Promise<RawSttResult> {
  const probe = await probeMedia(filePath);
  if (probe.durationSeconds <= VERTEX_MAX_CHUNK_SECONDS) {
    const single = await vertexTranscribeSingle(filePath);
    await onChunkDone?.(1, 1, single.language);
    return single;
  }

  const chunkDir = path.join(path.dirname(filePath), `vertex_chunks_${Date.now()}`);
  const refDir = path.join(chunkDir, 'refs');
  try {
    const chunkPaths = await splitAudioIntoChunks(filePath, VERTEX_MAX_CHUNK_SECONDS, chunkDir);
    await mkdir(refDir, { recursive: true });

    // Chunks are not exactly VERTEX_MAX_CHUNK_SECONDS long (ffmpeg splits on packet
    // boundaries), so each chunk's offset is the sum of the real durations before it,
    // not a fixed stride that would drift further out of sync the longer the video runs.
    const durations = await Promise.all(chunkPaths.map(async (p) => (await probeMedia(p)).durationSeconds));
    const offsets = durations.map((_, i) => durations.slice(0, i).reduce((a, b) => a + b, 0));

    let detectedLanguage = 'unknown';

    // Carries a short voice sample per speaker forward from whichever chunk first
    // captured a good one, so chunk 2 (say) can recognize "this is the same voice as
    // Speaker 1 from chunk 1" instead of numbering its speakers from scratch — without
    // this, "Speaker 1" in every chunk is only meaningful *within* that chunk, which
    // silently scrambles voice assignment on any multi-speaker video long enough to chunk.
    const knownSpeakers = new Map<string, string>();
    const results: (RawSttResult | null)[] = chunkPaths.map(() => null);
    let completed = 0;

    // The first chunk runs alone (it fixes the language and the first speakers' voices); the rest run in waves, each seeing every voice captured before it.
    for (let waveStart = 0; waveStart < chunkPaths.length; ) {
      const waveSize = waveStart === 0 ? 1 : STT_PARALLEL_CHUNKS;
      const wave = chunkPaths.map((_, i) => i).slice(waveStart, waveStart + waveSize);
      const references = Array.from(knownSpeakers, ([label, audioBase64]) => ({ label, audioBase64 }));
      const knownLanguage = detectedLanguage !== 'unknown' ? detectedLanguage : undefined;

      await Promise.all(
        wave.map(async (i) => {
          try {
            results[i] = await vertexTranscribeSingle(chunkPaths[i], references, knownLanguage);
          } catch (err) {
            // One bad chunk (e.g. a malformed JSON response) shouldn't sink the whole
            // transcript — skip it and keep the segments we did get.
            console.error(`[vertexClient] chunk ${i} transcription failed, skipping`, err);
          }
        })
      );

      // Language and voice samples are folded in chunk order, so the outcome never depends on which request happened to finish first.
      for (const i of wave) {
        const result = results[i];
        if (result?.language && result.language !== 'unknown' && detectedLanguage === 'unknown') detectedLanguage = result.language;
        if (result) await captureSpeakerReferences(chunkPaths[i], result.segments, knownSpeakers, refDir);
        completed++;
        await onChunkDone?.(completed, chunkPaths.length, detectedLanguage);
      }
      waveStart += waveSize;
    }

    if (results.every((r) => r === null)) {
      throw new Error('Vertex AI (Gemini) failed to transcribe any audio chunk');
    }

    const allSegments: RawSttSegment[] = [];
    const allText: string[] = [];
    // Chunk order, so a speaker's first confident description wins whichever request finished first.
    const speakers: Record<string, SpeakerProfile> = {};
    results.forEach((result, i) => {
      if (!result) return;
      const offset = offsets[i];
      if (result.text) allText.push(result.text);
      mergeSpeakerProfiles(speakers, Object.entries(result.speakers ?? {}).map(([label, profile]) => ({ label, ...profile })));
      for (const seg of result.segments) {
        allSegments.push({
          start: seg.start + offset,
          end: seg.end + offset,
          text: seg.text,
          confidence: seg.confidence,
          speaker: seg.speaker,
          delivery: seg.delivery,
          ...(seg.performance ? { performance: seg.performance } : {}),
          words: seg.words?.map((w) => ({ text: w.text, start: w.start + offset, end: w.end + offset })),
        });
      }
    });
    return { text: allText.join(' '), language: detectedLanguage, segments: allSegments, speakers };
  } finally {
    await rm(chunkDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// Gemini's `gemini-2.5-flash-preview-tts` synthesis previously lived here. It was replaced
// by Google Cloud TTS (see googleTtsClient.ts): the preview model capped requests per
// minute per project irrespective of billing, which a multi-segment dub exhausts in a
// single render.
