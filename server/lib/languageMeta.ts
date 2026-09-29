import { LANGUAGES } from '../../src/data/mockData';

export function getLanguageName(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.name || appLangCode;
}

export function getLanguageBcp47(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.bcp47 || 'en-US';
}

// The language whose tools (the forced aligner) a dialect or regional language borrows; the language itself otherwise.
export function toolLanguageCode(appLangCode: string): string {
  return LANGUAGES.find((l) => l.code === appLangCode)?.baseCode || appLangCode;
}

// Script each language must be written in; romanized output breaks the CTC aligner and TTS pronunciation.
interface ScriptRule {
  instruction: string;
  pattern: RegExp;
}

const NATIVE = (script: string, name: string, extra = ''): string =>
  `Write ONLY in the native ${script} script of ${name}. Never romanize or transliterate into Latin letters. English loanwords that were spoken must also be written in ${script} as they are pronounced; only brand names and acronyms may stay in Latin.${extra}`;

// A regional language of the Hindi belt: written in Devanagari, but with its own words and grammar, never standard Hindi.
const REGIONAL = (name: string, region: string): ScriptRule => ({
  instruction: NATIVE(
    'Devanagari',
    name,
    ` Write genuine spoken ${name} as people in ${region} talk: its own vocabulary, pronouns, verb endings and idioms. Do not fall back to standard Hindi words or grammar where ${name} has its own.`
  ),
  pattern: /\p{Script=Devanagari}/u,
});

const PERSO_ARABIC = (name: string): ScriptRule => ({
  instruction: `Write ONLY in the Perso-Arabic script used for ${name}. Never romanize. English loanwords that were spoken are written in that script as pronounced; only brand names and acronyms may stay in Latin.`,
  pattern: /\p{Script=Arabic}/u,
});

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
  or: { instruction: NATIVE('Odia', 'Odia'), pattern: /\p{Script=Oriya}/u },
  as: { instruction: NATIVE('Assamese (Bengali-Assamese)', 'Assamese', ' Use Assamese letters such as ৰ and ৱ, never Bengali spellings.'), pattern: /\p{Script=Bengali}/u },
  ur: PERSO_ARABIC('Urdu'),
  sd: PERSO_ARABIC('Sindhi'),
  ks: PERSO_ARABIC('Kashmiri'),
  mai: { instruction: NATIVE('Devanagari', 'Maithili', ' Use Maithili vocabulary and grammar, not Hindi.'), pattern: /\p{Script=Devanagari}/u },
  ne: { instruction: NATIVE('Devanagari', 'Nepali', ' Use Nepali vocabulary and grammar, not Hindi.'), pattern: /\p{Script=Devanagari}/u },
  kok: { instruction: NATIVE('Devanagari', 'Konkani', ' Use Konkani vocabulary and grammar, not Marathi.'), pattern: /\p{Script=Devanagari}/u },
  sa: { instruction: NATIVE('Devanagari', 'Sanskrit', ' Use correct classical Sanskrit grammar and sandhi.'), pattern: /\p{Script=Devanagari}/u },
  doi: { instruction: NATIVE('Devanagari', 'Dogri', ' Use Dogri vocabulary and grammar as spoken in Jammu, not Hindi or Punjabi.'), pattern: /\p{Script=Devanagari}/u },
  brx: { instruction: NATIVE('Devanagari', 'Bodo'), pattern: /\p{Script=Devanagari}/u },
  mni: { instruction: NATIVE('Bengali', 'Manipuri (Meitei)', ' Use the Bengali script as Manipuri newspapers do, with Meitei vocabulary and grammar.'), pattern: /\p{Script=Bengali}/u },
  sat: { instruction: NATIVE('Ol Chiki', 'Santali'), pattern: /\p{Script=Ol_Chiki}/u },
  tcy: { instruction: NATIVE('Kannada', 'Tulu', ' Use Tulu vocabulary and grammar as spoken in coastal Karnataka, not Kannada.'), pattern: /\p{Script=Kannada}/u },
  bho: REGIONAL('Bhojpuri', 'eastern Uttar Pradesh and western Bihar'),
  bgc: REGIONAL('Haryanvi', 'Haryana'),
  raj: REGIONAL('Rajasthani (Marwari)', 'Rajasthan'),
  awa: REGIONAL('Awadhi', 'Awadh (Lucknow to Ayodhya)'),
  mag: REGIONAL('Magahi', 'south Bihar'),
  hne: REGIONAL('Chhattisgarhi', 'Chhattisgarh'),
  bns: REGIONAL('Bundeli', 'Bundelkhand'),
  gbm: REGIONAL('Garhwali', 'Garhwal, Uttarakhand'),
  kfy: REGIONAL('Kumaoni', 'Kumaon, Uttarakhand'),
  lus: { instruction: 'Write in Mizo, in its standard Latin alphabet (with ṭ), using Mizo vocabulary and grammar.', pattern: /\p{Script=Latin}/u },
  en_in: { instruction: 'Write natural Indian English: phrasing Indian audiences use, British spelling, and Indian number words (lakh, crore) where amounts are spoken.', pattern: /\p{Script=Latin}/u },
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
