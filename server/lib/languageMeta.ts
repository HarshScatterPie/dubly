import { LANGUAGES } from '../../src/data/mockData';

/**
 * Sarvam's translate/TTS models only cover Indic languages (+ en-IN). This maps our
 * app's language codes onto Sarvam's `xx-IN` codes for the languages it actually
 * supports — anything not in this map must go through Vertex/OpenAI instead.
 */
const SARVAM_LANGUAGE_CODES: Record<string, string> = {
  hi: 'hi-IN',
  hinglish: 'hi-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  bn: 'bn-IN',
  mr: 'mr-IN',
  gu: 'gu-IN',
  kn: 'kn-IN',
  ml: 'ml-IN',
  pa: 'pa-IN',
  en: 'en-IN',
};

export function isSarvamSupportedLanguage(appLangCode: string): boolean {
  return appLangCode in SARVAM_LANGUAGE_CODES;
}

/** True for Indic-content languages where Sarvam is the preferred ("auto") provider. English is excluded on purpose — it defaults to the general-purpose providers even though Sarvam technically covers en-IN. */
export function isIndicLanguage(appLangCode: string): boolean {
  return isSarvamSupportedLanguage(appLangCode) && appLangCode !== 'en';
}

export function toSarvamLanguageCode(appLangCode: string): string | null {
  return SARVAM_LANGUAGE_CODES[appLangCode] ?? null;
}

export function getLanguageName(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.name || appLangCode;
}

export function getLanguageBcp47(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.bcp47 || 'en-US';
}

/**
 * STT providers report the detected source language in different shapes — Sarvam
 * returns a BCP-47-ish code (e.g. "hi-IN"), OpenAI Whisper returns a bare lowercase
 * language name (e.g. "english"). Maps either onto our app's language codes so the
 * *actually detected* language gets persisted, instead of silently keeping whatever
 * default was set before analysis ran.
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
