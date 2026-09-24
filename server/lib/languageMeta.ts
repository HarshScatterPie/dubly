import { LANGUAGES } from '../../src/data/mockData';

export function getLanguageName(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.name || appLangCode;
}

export function getLanguageBcp47(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.bcp47 || 'en-US';
}

// Script each language must be written in; romanized output breaks the CTC aligner and TTS pronunciation.
interface ScriptRule {
  instruction: string;
  pattern: RegExp;
}

const NATIVE = (script: string, name: string, extra = ''): string =>
  `Write ONLY in the native ${script} script of ${name}. Never romanize or transliterate into Latin letters. English loanwords that were spoken must also be written in ${script} as they are pronounced; only brand names and acronyms may stay in Latin.${extra}`;

const SCRIPT_RULES: Record<string, ScriptRule> = {
  hi: {
    instruction: NATIVE('Devanagari', 'Hindi', ' Use pure, natural spoken Hindi vocabulary — do not mix in English words where a common Hindi word exists.'),
    pattern: /\p{Script=Devanagari}/u,
  },
  hinglish: {
    instruction:
      'Write Hinglish: natural urban conversational Hindi mixed with everyday English words, the way young Indians text and talk. Write the WHOLE line in Roman (Latin) script — Hindi words romanized phonetically (e.g. "Aap kaise ho? Yeh product bahut useful hai."). Never use Devanagari.',
    pattern: /\p{Script=Latin}/u,
  },
  mr: { instruction: NATIVE('Devanagari', 'Marathi'), pattern: /\p{Script=Devanagari}/u },
  ta: { instruction: NATIVE('Tamil', 'Tamil'), pattern: /\p{Script=Tamil}/u },
  te: { instruction: NATIVE('Telugu', 'Telugu'), pattern: /\p{Script=Telugu}/u },
  bn: { instruction: NATIVE('Bengali', 'Bengali'), pattern: /\p{Script=Bengali}/u },
  gu: { instruction: NATIVE('Gujarati', 'Gujarati'), pattern: /\p{Script=Gujarati}/u },
  kn: { instruction: NATIVE('Kannada', 'Kannada'), pattern: /\p{Script=Kannada}/u },
  ml: { instruction: NATIVE('Malayalam', 'Malayalam'), pattern: /\p{Script=Malayalam}/u },
  pa: { instruction: NATIVE('Gurmukhi', 'Punjabi'), pattern: /\p{Script=Gurmukhi}/u },
  ja: { instruction: 'Write in natural Japanese script (kanji and kana). Never use romaji.', pattern: /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u },
  ko: { instruction: 'Write in Hangul. Never romanize.', pattern: /\p{Script=Hangul}/u },
  ar: { instruction: 'Write in Arabic script. Never romanize.', pattern: /\p{Script=Arabic}/u },
};

export function getScriptInstruction(appLangCode: string): string {
  return SCRIPT_RULES[appLangCode]?.instruction ?? '';
}

/** True when most of the letters in `text` are in the language's expected script. Languages without a rule (Latin-script European ones) always pass. */
export function isInExpectedScript(text: string, appLangCode: string): boolean {
  const rule = SCRIPT_RULES[appLangCode];
  if (!rule) return true;
  const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) return true;
  const matching = letters.filter((ch) => rule.pattern.test(ch)).length;
  // Majority test, since brand names and acronyms legitimately stay in Latin.
  return matching / letters.length >= 0.6;
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
