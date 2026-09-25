import type { SpeakerProfile } from '../../src/types';
import { performanceTagsIn } from './performance';

export interface TranslatableSegment {
  id: string;
  text: string;
  /** How long the original line occupies on screen. Given to the model as a budget so the translation is written to be speakable in that time. */
  durationSeconds?: number;
  /** Who says the line, so gendered grammar and forms of address come out right. */
  speaker?: string;
}

export interface TranslationContext {
  /** Speaker label -> gender and age as heard in the original. */
  speakers?: Record<string, SpeakerProfile>;
}

// One line per speaker the model needs to know about; empty for a lone speaker nobody could place.
export function describeSpeakers(segments: TranslatableSegment[], speakers: Record<string, SpeakerProfile> = {}): string {
  const labels = [...new Set(segments.map((s) => s.speaker).filter((s): s is string => Boolean(s)))];
  const known = labels.filter((label) => speakers[label] && speakers[label].gender !== 'unknown');
  if (labels.length < 2 && known.length === 0) return '';
  return labels
    .map((label) => {
      const p = speakers[label];
      if (!p || p.gender === 'unknown') return `- ${label}: gender unknown`;
      return `- ${label}: ${p.gender}${p.age ? `, ${p.age}` : ''}`;
    })
    .join('\n');
}

export function buildTranslationPrompt(
  segments: TranslatableSegment[],
  targetLanguageName: string,
  style: string,
  adaptExpressions: boolean,
  scriptInstruction = '',
  // Workspace glossary lines for the terms in these segments (glossary.glossaryInstruction).
  glossaryText = '',
  context: TranslationContext = {}
): string {
  const speakerText = describeSpeakers(segments, context.speakers);
  const hasTags = segments.some((s) => performanceTagsIn(s.text).length > 0);
  const list = segments
    .map((s) => {
      const fields = [`"id": ${JSON.stringify(s.id)}`];
      if (speakerText && s.speaker) fields.push(`"speaker": ${JSON.stringify(s.speaker)}`);
      if (s.durationSeconds) fields.push(`"seconds": ${s.durationSeconds.toFixed(1)}`);
      fields.push(`"text": ${JSON.stringify(s.text)}`);
      return `{${fields.join(', ')}}`;
    })
    .join(',\n  ');

  return `You are a professional video dubbing translator. Translate each dialogue segment below into ${targetLanguageName}.

Style: ${style}.
${scriptInstruction ? `SCRIPT & VOCABULARY (critical): ${scriptInstruction}\n` : ''}${
    glossaryText ? `GLOSSARY (mandatory, overrides the script rule for these terms):\n${glossaryText}\n` : ''
  }Translate every segment fully into ${targetLanguageName} — never leave a segment in the source language, never add content that is not in the source, and never merge or split segments.
${
  adaptExpressions
    ? 'Adapt idioms and cultural references naturally for a native speaker rather than translating literally.'
    : 'Stay close to the literal meaning; avoid paraphrasing.'
}
CRITICAL — timing. Each segment gives "seconds": the exact time that line occupies on screen. Your translation must be comfortably speakable aloud within that time at an unhurried, natural pace. This constraint outranks completeness: if a faithful translation would run long, tighten it — drop filler, choose shorter synonyms, and cut anything redundant — rather than producing a line that has to be rushed to fit. A line that must be sped up to fit sounds robotic and breaks the performance, so prefer a slightly leaner translation that breathes.
Match the register and emotional tone of the original (excitement, hesitation, emphasis, humour) so the delivery carries the same feeling, and keep it natural to say out loud rather than literary.
${
  speakerText
    ? `SPEAKERS (heard in the original audio):
${speakerText}
Each segment names its speaker. Wherever ${targetLanguageName} marks gender (verb endings, adjectives, first-person forms, how "you" is said to a man or a woman), make it agree with the real speaker and the person they address. Pick one register for how each pair of speakers addresses each other and how they address the audience (formal or informal "you"), and keep it for the whole video.
`
    : ''
}${
  hasTags
    ? `PERFORMANCE TAGS: some segments contain bracketed tags such as [laughing] or [sigh]. They are sounds the voice performs, not words. Keep each one exactly as written, in English, at the matching point of your translation, and never add a tag the segment does not have.
`
    : ''
}
Return ONLY a JSON object of the exact form:
{"translations": [{"id": "<same id as input>", "translatedText": "<translation>"}]}
One entry per input segment, preserving the exact "id" values given. No commentary, no markdown fences.

Segments:
[
  ${list}
]`;
}

export function parseTranslationResponse(raw: string): Record<string, string> {
  const cleaned = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```\s*$/i, '');

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Model returned non-JSON translation response: ${(err as Error).message}`);
  }

  const arr = Array.isArray(parsed)
    ? parsed
    : (parsed as { translations?: unknown; segments?: unknown })?.translations ??
      (parsed as { segments?: unknown })?.segments;

  if (!Array.isArray(arr)) {
    throw new Error('Unexpected translation response shape (expected an array of {id, translatedText})');
  }

  const map: Record<string, string> = {};
  for (const item of arr) {
    if (item && typeof item === 'object' && typeof (item as any).id === 'string') {
      const translatedText = (item as any).translatedText ?? (item as any).text;
      if (typeof translatedText === 'string') {
        map[(item as any).id] = translatedText;
      }
    }
  }
  return map;
}
