import type { GlossaryEntry } from '../../src/types';

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Latin-script terms match as whole words ("Pie" must not match "Pier"); other scripts have no reliable word boundary, so they match as substrings.
function termPattern(term: string): RegExp {
  const escaped = escapeRegex(term.normalize('NFC'));
  return /^[\p{Script=Latin}\p{N}\s\-'’.&+]+$/u.test(term)
    ? new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'giu')
    : new RegExp(escaped, 'giu');
}

export function containsTerm(text: string, term: string): boolean {
  return termPattern(term).test(text.normalize('NFC'));
}

// The entries whose term appears in any of the texts, so a prompt carries only the terms that matter for it.
export function relevantEntries(entries: GlossaryEntry[], texts: string[]): GlossaryEntry[] {
  return entries.filter((entry) => texts.some((text) => containsTerm(text, entry.term)));
}

// What a term must become in a language, or null when the glossary leaves it to the translator.
export function requiredRendering(entry: GlossaryEntry, languageCode: string): string | null {
  if (entry.mode === 'keep') return entry.term;
  return entry.translations?.[languageCode]?.trim() || null;
}

// Prompt lines for the terms that constrain this language; empty when none do.
export function glossaryInstruction(entries: GlossaryEntry[], languageCode: string): string {
  const lines = entries.flatMap((entry) => {
    const rendering = requiredRendering(entry, languageCode);
    if (!rendering) return [];
    return entry.mode === 'keep'
      ? [`- "${entry.term}": a name; keep it exactly as "${entry.term}", never translate or transliterate it.`]
      : [`- "${entry.term}": always translate as "${rendering}".`];
  });
  return lines.length ? lines.join('\n') : '';
}

// Terms spoken in the source line whose required rendering is missing from its translation.
export function glossaryMisses(sourceText: string, translatedText: string, entries: GlossaryEntry[], languageCode: string): GlossaryEntry[] {
  const translated = translatedText.normalize('NFC').toLocaleLowerCase();
  return entries.filter((entry) => {
    const rendering = requiredRendering(entry, languageCode);
    return rendering !== null && containsTerm(sourceText, entry.term) && !translated.includes(rendering.normalize('NFC').toLocaleLowerCase());
  });
}

// The text minus the names the glossary keeps verbatim, so a Latin brand name in a short Hindi line does not read as the wrong script.
export function withoutKeptTerms(text: string, entries: GlossaryEntry[]): string {
  return entries.reduce((out, entry) => (entry.mode === 'keep' ? out.replace(termPattern(entry.term), ' ') : out), text);
}

// Swaps each term the voice would mispronounce for its phonetic respelling; only the spoken text changes, never the saved line.
export function applySpokenForms(text: string, entries: GlossaryEntry[]): string {
  return entries.reduce((out, entry) => {
    const spoken = entry.spokenAs;
    return spoken ? out.replace(termPattern(entry.term), () => spoken) : out;
  }, text);
}
