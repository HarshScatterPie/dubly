import { LANGUAGES } from '../../src/data/mockData';

export function getLanguageName(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.name || appLangCode;
}

export function getLanguageBcp47(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.bcp47 || 'en-US';
}

/**
 * Gemini reports the detected source language as a plain name (e.g. "English" or
 * "Hindi"), not a code. Maps that onto our app's language codes so the *actually
 * detected* language gets persisted, instead of silently keeping whatever default was
 * set before analysis ran.
 */
export function mapDetectedLanguageToAppCode(detected: string): string {
  const normalized = detected.trim().toLowerCase();
  if (!normalized || normalized === 'unknown') return 'en';

  const bcpMatch = LANGUAGES.find((l) => {
    const bcp = l.bcp47.toLowerCase();
    return bcp === normalized || bcp.split('-')[0] === normalized.split('-')[0];
  });
  if (bcpMatch) return bcpMatch.code;

  const nameMatch = LANGUAGES.find((l) => l.name.toLowerCase().replace(/\s*\(.*\)/, '').trim() === normalized);
  if (nameMatch) return nameMatch.code;

  return 'en';
}

/**
 * Ceiling on target languages per project. Every language is its own translation call now
 * and its own full TTS + render pass later, so this is the guard against one click quietly
 * running up a very large provider bill.
 */
export const MAX_TARGET_LANGUAGES = 10;

/**
 * Resolves and validates the target languages a request is asking for.
 *
 * Accepts either the multi-select list or the single code older clients send, so a request
 * written before multi-language dubbing keeps working unchanged.
 */
export function resolveTargetLanguages(
  body: Record<string, unknown>,
  fallback: string
): { languages: string[] } | { error: string } {
  const requested = Array.isArray(body.targetLanguageCodes)
    ? (body.targetLanguageCodes as unknown[]).filter((c): c is string => typeof c === 'string')
    : typeof body.targetLanguageCode === 'string'
    ? [body.targetLanguageCode]
    : [fallback];

  const deduped = [...new Set(requested.filter(Boolean))];
  if (deduped.length === 0) return { error: 'Pick at least one target language' };
  if (deduped.length > MAX_TARGET_LANGUAGES) {
    return { error: `Pick at most ${MAX_TARGET_LANGUAGES} languages at a time` };
  }
  const unknown = deduped.filter((code) => !LANGUAGES.some((l) => l.code === code));
  if (unknown.length > 0) return { error: `Unsupported language: ${unknown.join(', ')}` };
  return { languages: deduped };
}
