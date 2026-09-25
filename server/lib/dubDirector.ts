import { env } from './env';
import { log } from './log';
import { mapWithConcurrency } from './concurrency';
import { vertexGenerateJson, type VertexPart } from './vertexClient';

// AI review: Gemini on Vertex hears each dubbed take next to its original line and flags what a native viewer would notice, so the render can re-record it.

export const REVIEW_PROBLEMS = ['garbled', 'missing_words', 'mispronounced', 'wrong_language', 'wrong_emotion'] as const;
export type ReviewProblem = (typeof REVIEW_PROBLEMS)[number];

export interface ReviewLine {
  id: string;
  // What the voice had to say, performance tags included, so an intended laugh is not reported as noise.
  script: string;
  delivery?: string;
  // 16 kHz mono WAV of the original line; omitted when the source could not be sliced.
  original?: Buffer;
  // The dubbed take as synthesized (WAV).
  dubbed: Buffer;
}

export interface LineVerdict {
  ok: boolean;
  problem?: ReviewProblem;
  // Short English note for the editor, e.g. "mispronounces 'ScatterPie'".
  note?: string;
  // How to perform the line on a retake, for the voice's style prompt.
  direction?: string;
}

// Lines per request: enough to amortise the prompt, small enough that one bad response loses little.
const LINES_PER_REQUEST = 8;
const PARALLEL_REQUESTS = 3;
const MAX_NOTE_LENGTH = 120;

function clip(text: unknown): string | undefined {
  if (typeof text !== 'string') return undefined;
  const cleaned = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_LENGTH).trim();
  return cleaned || undefined;
}

export function buildReviewPrompt(languageName: string): string {
  return `You are the dubbing director reviewing an AI-voiced ${languageName} dub, line by line. For each line you get the script the voice had to say, the delivery it should have, the ORIGINAL line (source language, may have music under it), then the DUBBED take.
Judge only the dubbed take. Flag a line only for something a native ${languageName} viewer would clearly notice:
- "garbled": slurred, babbling, cut off, repeated or invented words, glitches or noise.
- "missing_words": part of the script was not spoken.
- "mispronounced": a word said so wrongly that a native speaker would stumble (name the word in the note).
- "wrong_language": not spoken in ${languageName}, or with a heavy foreign accent.
- "wrong_emotion": the feeling plainly contradicts the original (cheerful where it is sad or angry, flat where it is excited).
Bracketed tags in the script such as [laughing] or [sigh] are sounds the voice should perform, not words. Small differences in accent, pace or style are fine: mark those lines ok.
Return ONLY {"lines": [{"id": "<id>", "ok": true}, {"id": "<id>", "ok": false, "problem": "<one of the five>", "note": "<max 12 English words naming the issue>", "direction": "<max 12 English words: how to perform it on a retake>"}]} with one entry per line.`;
}

export function parseReviewResponse(raw: string, ids: string[]): Map<string, LineVerdict> {
  const verdicts = new Map<string, LineVerdict>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return verdicts;
  }
  const lines = (parsed as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) return verdicts;
  const wanted = new Set(ids);
  for (const entry of lines) {
    const id = typeof entry?.id === 'string' ? entry.id : '';
    if (!wanted.has(id) || verdicts.has(id)) continue;
    const problem = REVIEW_PROBLEMS.find((p) => p === entry.problem);
    // A "not ok" without a recognised problem is too vague to act on, so it counts as ok.
    if (entry.ok === false && problem) {
      verdicts.set(id, { ok: false, problem, note: clip(entry.note), direction: clip(entry.direction) });
    } else {
      verdicts.set(id, { ok: true });
    }
  }
  return verdicts;
}

function wavPart(buffer: Buffer): VertexPart {
  return { inlineData: { mimeType: 'audio/wav', data: buffer.toString('base64') } };
}

async function reviewBatch(batch: ReviewLine[], languageName: string): Promise<Map<string, LineVerdict>> {
  const parts: VertexPart[] = [{ text: buildReviewPrompt(languageName) }];
  for (const line of batch) {
    parts.push({ text: `Line ${JSON.stringify(line.id)}. Script: ${JSON.stringify(line.script)}${line.delivery ? `. Delivery: ${line.delivery}` : ''}.` });
    if (line.original) {
      parts.push({ text: 'ORIGINAL:' }, wavPart(line.original));
    }
    parts.push({ text: 'DUBBED take:' }, wavPart(line.dubbed));
  }
  const raw = await vertexGenerateJson(env.geminiReviewModel, parts, 'dub-review', 2048);
  return parseReviewResponse(raw, batch.map((l) => l.id));
}

// Verdicts for every line the reviewer answered; a line missing from the map was not reviewed (a failed batch), never "bad".
export async function reviewDubbedLines(lines: ReviewLine[], languageName: string): Promise<Map<string, LineVerdict>> {
  const batches: ReviewLine[][] = [];
  for (let i = 0; i < lines.length; i += LINES_PER_REQUEST) batches.push(lines.slice(i, i + LINES_PER_REQUEST));
  const results = await mapWithConcurrency(batches, PARALLEL_REQUESTS, async (batch) => {
    try {
      return await reviewBatch(batch, languageName);
    } catch (err) {
      log.warn('dub_review_batch_failed', { lines: batch.length, error: (err as Error)?.message }, '[review] a review batch failed; its lines keep their first take');
      return new Map<string, LineVerdict>();
    }
  });
  return new Map(results.flatMap((m) => [...m]));
}

// The style prompt for a retake: the original direction plus what the reviewer asked for.
export function retakeStyle(style: string, verdict: LineVerdict): string {
  const fix =
    verdict.problem === 'wrong_emotion' && verdict.direction
      ? `Director's note for this take: ${verdict.direction}.`
      : verdict.problem === 'mispronounced' && verdict.note
        ? `Pronounce every word clearly and correctly (${verdict.note}).`
        : 'Say every word of the line clearly and completely, at a natural pace.';
  return style ? `${style} ${fix}` : fix;
}

const PROBLEM_NOTES: Record<ReviewProblem, string> = {
  garbled: 'garbled or cut-off speech',
  missing_words: 'words missing from the take',
  mispronounced: 'a word is mispronounced',
  wrong_language: 'not clearly in the target language',
  wrong_emotion: 'delivery does not match the original',
};

// What the editor shows next to a line the review could not fix.
export function describeVerdict(verdict: LineVerdict): string {
  return verdict.note || (verdict.problem ? PROBLEM_NOTES[verdict.problem] : 'flagged by the AI review');
}
