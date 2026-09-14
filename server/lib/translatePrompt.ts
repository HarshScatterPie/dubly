export interface TranslatableSegment {
  id: string;
  text: string;
  /** How long the original line occupies on screen. Given to the model as a budget so the translation is written to be speakable in that time. */
  durationSeconds?: number;
}

export function buildTranslationPrompt(
  segments: TranslatableSegment[],
  targetLanguageName: string,
  style: string,
  adaptExpressions: boolean
): string {
  const list = segments
    .map((s) =>
      s.durationSeconds
        ? `{"id": ${JSON.stringify(s.id)}, "seconds": ${s.durationSeconds.toFixed(1)}, "text": ${JSON.stringify(s.text)}}`
        : `{"id": ${JSON.stringify(s.id)}, "text": ${JSON.stringify(s.text)}}`
    )
    .join(',\n  ');

  return `You are a professional video dubbing translator. Translate each dialogue segment below into ${targetLanguageName}.

Style: ${style}.
${
  adaptExpressions
    ? 'Adapt idioms and cultural references naturally for a native speaker rather than translating literally.'
    : 'Stay close to the literal meaning; avoid paraphrasing.'
}
CRITICAL — timing. Each segment gives "seconds": the exact time that line occupies on screen. Your translation must be comfortably speakable aloud within that time at an unhurried, natural pace. This constraint outranks completeness: if a faithful translation would run long, tighten it — drop filler, choose shorter synonyms, and cut anything redundant — rather than producing a line that has to be rushed to fit. A line that must be sped up to fit sounds robotic and breaks the performance, so prefer a slightly leaner translation that breathes.
Match the register and emotional tone of the original (excitement, hesitation, emphasis, humour) so the delivery carries the same feeling, and keep it natural to say out loud rather than literary.

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
