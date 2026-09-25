// Gemini-TTS markup tags a dubbed line may carry: every one is performed by the voice, never read aloud (verified on Cloud TTS).
export const PERFORMANCE_TAGS = ['laughing', 'sigh', 'uhm', 'whispering', 'shouting', 'sarcasm', 'short pause', 'medium pause', 'long pause'] as const;
export type PerformanceTag = (typeof PERFORMANCE_TAGS)[number];

// The non-speech sounds transcription is asked to mark; the rest are for people directing a line by hand.
export const HEARD_TAGS: PerformanceTag[] = ['laughing', 'sigh'];

const ALLOWED = new Set<string>(PERFORMANCE_TAGS);
const BRACKETED = /\[([^\]\n]{1,40})\]/g;

function canonical(inner: string): string {
  return inner.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function isPerformanceTag(inner: string): boolean {
  return ALLOWED.has(canonical(inner));
}

// The tags in a line, in order, in canonical spelling.
export function performanceTagsIn(text: string): PerformanceTag[] {
  return [...text.matchAll(BRACKETED)].map((m) => canonical(m[1])).filter((t): t is PerformanceTag => ALLOWED.has(t));
}

function tidy(text: string): string {
  return text.replace(/\s+([,.!?।॥。！？…])/g, '$1').replace(/\s+/g, ' ').trim();
}

// The line as it is read and captioned: performance tags removed, anything else untouched.
export function stripPerformanceTags(text: string): string {
  if (!text.includes('[')) return text;
  return tidy(text.replace(BRACKETED, (whole, inner: string) => (isPerformanceTag(inner) ? ' ' : whole)));
}

// Keeps only allowed tags, in canonical spelling, and optionally only those the source line had (a translation must not invent a laugh).
export function sanitizePerformanceTags(text: string, allowedFrom?: string): string {
  if (!text.includes('[')) return text;
  const budget = new Map<string, number>();
  if (allowedFrom !== undefined) for (const tag of performanceTagsIn(allowedFrom)) budget.set(tag, (budget.get(tag) ?? 0) + 1);
  return tidy(
    text.replace(BRACKETED, (whole, inner: string) => {
      const tag = canonical(inner);
      if (!ALLOWED.has(tag)) return whole;
      if (allowedFrom === undefined) return ` [${tag}] `;
      const left = budget.get(tag) ?? 0;
      if (left <= 0) return ' ';
      budget.set(tag, left - 1);
      return ` [${tag}] `;
    })
  );
}

function letters(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

// A transcription's tagged version of a line, accepted only when it is the same words plus heard sounds.
export function acceptHeardPerformance(text: string, performance: unknown): string | undefined {
  if (typeof performance !== 'string' || !performance.includes('[')) return undefined;
  const cleaned = tidy(
    performance.replace(BRACKETED, (whole, inner: string) => (HEARD_TAGS.includes(canonical(inner) as PerformanceTag) ? ` [${canonical(inner)}] ` : ' '))
  );
  if (!performanceTagsIn(cleaned).length) return undefined;
  return letters(stripPerformanceTags(cleaned)) === letters(text) ? cleaned : undefined;
}
