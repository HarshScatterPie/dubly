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

// Standard-Hindi function words. Devanagari alone cannot tell a regional language from Hindi, so a line full of these is Hindi in disguise.
// Each regional language lists the ones it genuinely shares with Hindi in `shared`.
const HINDI_ONLY = [
  'है', 'हैं', 'हूं', 'था', 'थी', 'थे', 'रहा', 'रही', 'मैं', 'मेरा', 'मेरी', 'तुम्हारा', 'तुम्हारी', 'आपका', 'आपकी',
  'क्यों', 'कहां', 'यहां', 'वहां', 'बहुत', 'नहीं', 'लेकिन', 'इसलिए', 'क्या', 'सकता', 'सकते', 'सकती',
];

interface RegionalProfile {
  name: string;
  region: string;
  /** Real forms of this language next to the Hindi they replace; the model is far more reliable copying concrete forms than following "be authentic". */
  forms: string;
  shared?: string[];
}

const REGIONAL_PROFILES: Record<string, RegionalProfile> = {
  bho: { name: 'Bhojpuri', region: 'eastern Uttar Pradesh and western Bihar', shared: ['रही'], forms: 'है→बा/बाटे, हैं→बाड़ें, था→रहल, मेरा→हमार, तुम्हारा→तोहार, आप→रउआ, क्या→का, कैसे→कइसे, क्यों→काहे, बहुत→बहुते, नहीं→ना/नइखे, जाऊंगा→जाइब, कर रहा हूं→करत बानी' },
  bgc: { name: 'Haryanvi', region: 'Haryana', shared: ['मैं', 'था', 'थी', 'थे'], forms: 'है→सै, हैं→सैं, हूं→सूं, मेरा→मेरा/म्हारा, तुम्हारा→थारा, क्या→के, कौन→कुण, कहां→कड़े, अब→इब, बहुत→घणा, ऐसे→न्यूं, नहीं→ना/कोनी, रहा→रह्या' },
  raj: { name: 'Rajasthani (Marwari)', region: 'Rajasthan', shared: ['है', 'हैं'], forms: 'है→छै/है, मेरा→म्हारो, तुम्हारा→थारो, हम→आपां/म्हे, क्या→कांई/के, कहां→कठै, कौन→कुण, बहुत→घणो, नहीं→कोनी/नीं, था→हो/थो, कैसे→किंया, आप→आप/सा' },
  awa: { name: 'Awadhi', region: 'Awadh (Lucknow to Ayodhya)', shared: ['रहा', 'रही'], forms: 'है→अहै/आय, हैं→अहैं, मेरा→हमार, तुम्हारा→तोहार, क्या→का, कैसे→कइसे, क्यों→काहे, बहुत→बहुतै, नहीं→नाहीं, जाऊंगा→जाब, यहां→इहां, वहां→उहां' },
  mag: { name: 'Magahi', region: 'south Bihar', forms: 'है→हइ/हे, मेरा→हमर, तुम्हारा→तोहर/तोर, क्या→की/का, कैसे→कइसन, क्यों→काहे, बहुत→बहुत/ढेर, नहीं→नइ/नै, रहा→रहल, जाऊंगा→जइबौ' },
  hne: { name: 'Chhattisgarhi', region: 'Chhattisgarh', forms: 'है→हे/हावय, हैं→हें/हावंय, था→रिहिस, मेरा→मोर, तुम्हारा→तोर/तुंहर, क्या→का, कैसे→कइसे, बहुत→गजब/बड़, नहीं→नइ/नहीं, जाता है→जाथे, अच्छा→बढ़िया/बने' },
  bns: { name: 'Bundeli', region: 'Bundelkhand', shared: ['है', 'हैं', 'था', 'थी', 'थे', 'रहा', 'रही'], forms: 'मेरा→हमाओ/मोरो, तुम्हारा→तुमाओ, क्या→का/काए, क्यों→काए, यहां→इतै, वहां→उतै, ऐसा→ऐसो, हुआ→भओ, गया→गओ, बहुत→भौत, नहीं→नईं, कहां→कां' },
  gbm: { name: 'Garhwali', region: 'Garhwal, Uttarakhand', forms: 'है→छ, हैं→छन, था→थौ, मैं→मि, मेरा→मेरु, तुम्हारा→तुमारु, क्या→क्य, कहां→कख, यहां→यख, वहां→वख, क्यों→किलै, बहुत→भौत, नहीं→नि, कहते हैं→बल, अच्छा→भलु/बढ़िया, हुआ→ह्वे' },
  kfy: { name: 'Kumaoni', region: 'Kumaon, Uttarakhand', forms: 'है→छ, हैं→छन/छीं, हूं→छूं, था→छी/भै, मैं→मैं/मी, मेरा→मेरो, तुम्हारा→तुमर/तुमरो, क्या→कि/के, कहां→कां, यहां→यां, वहां→वां, क्यों→किलै, बहुत→भौत, नहीं→न/नैं, अच्छा→भल, बच्चे→नानतिन, कर रहे हैं→करणईं/करणौ छ' },
};

const normalizeNasal = (s: string): string => s.replace(/ँ/g, 'ं');

// A regional language of the Hindi belt: written in Devanagari, but with its own words and grammar, never standard Hindi.
const REGIONAL = (code: string): ScriptRule => {
  const { name, region, forms } = REGIONAL_PROFILES[code];
  return {
    instruction: NATIVE(
      'Devanagari',
      name,
      ` The output must be genuine spoken ${name} as people in ${region} talk — NOT standard Hindi respelled. Hindi with a few local words is a failure. Use ${name}'s own pronouns, verb endings, "to be" forms, question words, postpositions and idioms in every sentence. Hindi → ${name} forms to apply: ${forms}.`
    ),
    pattern: /\p{Script=Devanagari}/u,
  };
};

/** Standard-Hindi words in a line meant to be a regional language; empty when it reads as the language itself. */
export function standardHindiLeak(text: string, appLangCode: string): string[] {
  const profile = REGIONAL_PROFILES[appLangCode];
  if (!profile) return [];
  const banned = new Set(HINDI_ONLY.filter((w) => !profile.shared?.includes(w)).map(normalizeNasal));
  const tokens = normalizeNasal(text).match(/[\p{L}\p{M}]+/gu) ?? [];
  const hits = tokens.filter((t) => banned.has(t));
  // One stray Hindi word is natural code-mixing; two, or a fifth of a line, is Hindi.
  return hits.length >= 2 || (tokens.length > 0 && hits.length / tokens.length >= 0.2) ? [...new Set(hits)] : [];
}

export const isRegionalLanguage = (appLangCode: string): boolean => appLangCode in REGIONAL_PROFILES;

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
  ...Object.fromEntries(Object.keys(REGIONAL_PROFILES).map((code) => [code, REGIONAL(code)])),
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
