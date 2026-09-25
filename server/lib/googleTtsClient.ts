import textToSpeech from '@google-cloud/text-to-speech';
import type { protos } from '@google-cloud/text-to-speech';
import { gcpServiceAccountPath, hasGoogleCredentials, useAdc } from './credentials';
import { env } from './env';
import { log } from './log';
import { stripPerformanceTags } from './performance';
import { silenceWav } from './audioUtils';

/**
 * Google Cloud Text-to-Speech (the GA service), used in place of Gemini's
 * `*-preview-tts` model.
 *
 * The preview model was rate-limited per *minute* per project regardless of billing, and
 * a dub issues one synthesis call per segment back-to-back — so a 26-segment video
 * reliably exhausted it (429 RESOURCE_EXHAUSTED) and failed the whole render. Cloud TTS
 * is the generally-available service on the same GCP project and credits, with production
 * quotas and far broader voice coverage (2066 voices; 30 top-tier Chirp3-HD voices for 19
 * of our 20 languages).
 *
 * Conveniently, Chirp3-HD shares its voice roster names (Aoede, Charon, Kore, ...) with
 * the Gemini TTS voices our personas were already mapped to, so each persona keeps its
 * intended timbre — verified that all 17 mapped names exist as Chirp3-HD.
 */
type IVoice = protos.google.cloud.texttospeech.v1.IVoice;

let client: InstanceType<typeof textToSpeech.TextToSpeechClient> | null = null;
let voicesPromise: Promise<IVoice[]> | null = null;
const resolvedVoiceCache = new Map<string, string>();

export function isGoogleTtsConfigured(): boolean {
  return hasGoogleCredentials();
}

function getClient() {
  if (!client) {
    if (!isGoogleTtsConfigured()) {
      throw new Error('Google Cloud TTS is not configured (no gcp-service-account.json and CREDENTIALS_MODE is not adc)');
    }
    client = new textToSpeech.TextToSpeechClient(useAdc ? {} : { keyFilename: gcpServiceAccountPath });
  }
  return client;
}

/** The full voice catalog rarely changes and is ~2000 entries, so fetch it once per process. */
function listAllVoices(): Promise<IVoice[]> {
  if (!voicesPromise) {
    voicesPromise = getClient()
      .listVoices({})
      .then(([res]) => res.voices || [])
      .catch((err) => {
        voicesPromise = null; // let a transient failure be retried rather than cached forever
        throw err;
      });
  }
  return voicesPromise;
}

function wantedGender(gender: string): string {
  return gender === 'male' ? 'MALE' : gender === 'female' ? 'FEMALE' : 'NEUTRAL';
}

/**
 * Picks the best real voice id for a language, preferring the persona's own timbre and
 * degrading gracefully: exact Chirp3-HD match -> any Chirp3-HD of the right gender ->
 * any voice of the right gender -> any voice at all. The tail of that chain matters for
 * languages Chirp3-HD doesn't cover yet (e.g. Arabic), which would otherwise hard-fail.
 */
async function resolveVoice(
  bcp47: string,
  preferredName: string,
  gender: string
): Promise<{ name: string; languageCode: string }> {
  const cacheKey = `${bcp47}|${preferredName}|${gender}`;
  const cached = resolvedVoiceCache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  const all = await listAllVoices();
  let languageCode = bcp47;
  let forLang = all.filter((v) => (v.languageCodes || []).includes(languageCode));

  if (forLang.length === 0) {
    // The app's locale for a language doesn't always match the one Google publishes
    // voices under — Arabic is the live example: we say ar-SA, Google only ships the
    // pan-Arabic ar-XA. Rather than special-casing, retry on the primary subtag so any
    // such mismatch resolves instead of hard-failing the dub.
    const primary = bcp47.split('-')[0].toLowerCase();
    const alternative = all
      .flatMap((v) => v.languageCodes || [])
      .find((code) => code.toLowerCase().startsWith(`${primary}-`));
    if (alternative) {
      languageCode = alternative;
      forLang = all.filter((v) => (v.languageCodes || []).includes(languageCode));
    }
  }
  if (forLang.length === 0) {
    throw new Error(`Google Cloud TTS has no voices for language ${bcp47}`);
  }

  const genderMatch = (v: IVoice) => String(v.ssmlGender) === wantedGender(gender);
  const exact = forLang.find((v) => v.name === `${languageCode}-Chirp3-HD-${preferredName}`);
  const chirpSameGender = forLang.find((v) => (v.name || '').includes('Chirp3-HD') && genderMatch(v));
  const anySameGender = forLang.find(genderMatch);

  const chosen = exact || chirpSameGender || anySameGender || forLang[0];
  const resolved = { name: chosen.name!, languageCode };
  resolvedVoiceCache.set(cacheKey, JSON.stringify(resolved));
  return resolved;
}

export type TtsEngine = 'gemini' | 'chirp';

// Gemini-TTS request limits: 4,000 bytes of text, 8,000 of text and prompt together.
const GEMINI_MAX_TEXT_BYTES = 4000;
const GEMINI_MAX_TOTAL_BYTES = 8000;
// Out of quota: voice with Chirp3-HD for a while instead of waiting out a retry on every line of a long dub.
const GEMINI_QUOTA_PAUSE_MS = 90_000;
// Model not enabled or not permitted for this project: an operator has to act, so stop trying for longer.
const GEMINI_UNAVAILABLE_PAUSE_MS = 30 * 60_000;
// A language refused this many times in a row is treated as unsupported; one refusal may just be that line's text.
const GEMINI_REFUSALS_BEFORE_SKIP = 3;

// Per model, so a preview model out of quota or withdrawn hands over to the GA one instead of straight to Chirp3-HD.
const geminiPausedUntil = new Map<string, number>();
const geminiRefusals = new Map<string, number>();

// Test seam: clears the fallback state between tests.
export function resetGeminiTtsStateForTests(): void {
  geminiPausedUntil.clear();
  geminiRefusals.clear();
}

// The Gemini-TTS models to try, best first: the premium model only for users who turned it on, then the standard GA one.
export function geminiTtsModels(premium = false): string[] {
  return [...new Set([premium ? env.geminiTtsPremiumModel : '', env.geminiTtsModel].filter(Boolean))];
}

// Gemini voices do not accept every locale Chirp3-HD does; verified on Cloud TTS: bn-IN is refused, bn-BD is served.
const GEMINI_LOCALES: Record<string, string> = { 'bn-IN': 'bn-BD' };

export function geminiLocaleFor(bcp47: string): string {
  return GEMINI_LOCALES[bcp47] ?? bcp47;
}

function modelUsable(model: string, bcp47: string): boolean {
  return Date.now() >= (geminiPausedUntil.get(model) ?? 0) && (geminiRefusals.get(`${model}|${bcp47}`) ?? 0) < GEMINI_REFUSALS_BEFORE_SKIP;
}

// The models that would take a line in this language right now, in the order they are tried; the router reads the cache in the same order.
export function usableGeminiTtsModels(bcp47: string, premium = false): string[] {
  return env.ttsEngine === 'gemini' ? geminiTtsModels(premium).filter((model) => modelUsable(model, bcp47)) : [];
}

// Whether a line in this language would be voiced by Gemini right now; the router uses it to pick the matching cache entry.
export function geminiTtsUsable(bcp47: string, premium = false): boolean {
  return usableGeminiTtsModels(bcp47, premium).length > 0;
}

function grpcCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' ? code : undefined;
}

// gRPC status codes, matched by number or by the name in the message.
function isQuotaError(err: unknown): boolean {
  return grpcCode(err) === 8 || /RESOURCE_EXHAUSTED|quota/i.test(String((err as Error)?.message ?? err));
}
function isRefusal(err: unknown): boolean {
  return grpcCode(err) === 3 || /INVALID_ARGUMENT/i.test(String((err as Error)?.message ?? err));
}
function isUnavailableModel(err: unknown): boolean {
  const code = grpcCode(err);
  return code === 5 || code === 7 || code === 9 || code === 12 || /PERMISSION_DENIED|NOT_FOUND|FAILED_PRECONDITION|UNIMPLEMENTED/i.test(String((err as Error)?.message ?? err));
}

function toBuffer(audio: Uint8Array | string | null | undefined, voiceName: string): Buffer {
  if (!audio) throw new Error(`Google Cloud TTS returned no audio for voice ${voiceName}`);
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio as Uint8Array);
}

// Gemini voices share the Chirp3-HD persona names, so the persona is passed as is and the model does the language.
async function geminiSynthesize(model: string, text: string, bcp47: string, voiceName: string, style: string): Promise<Buffer> {
  const [response] = await getClient().synthesizeSpeech({
    input: style ? { text, prompt: style } : { text },
    voice: { languageCode: geminiLocaleFor(bcp47), name: voiceName, modelName: model },
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
  });
  return toBuffer(response.audioContent, `${model}/${voiceName}`);
}

async function chirpSynthesize(text: string, bcp47: string, preferredVoiceName: string, gender: string): Promise<Buffer> {
  // Chirp3-HD cannot perform [laughing] and friends, and would read them aloud.
  const words = stripPerformanceTags(text).trim();
  // A line that is only a laugh has nothing for Chirp3-HD to say; a beat of silence keeps its place.
  if (!/[\p{L}\p{N}]/u.test(words)) return silenceWav(0.3, 24000);
  const voice = await resolveVoice(bcp47, preferredVoiceName, gender);
  const [response] = await getClient().synthesizeSpeech({
    input: { text: words },
    voice: { languageCode: voice.languageCode, name: voice.name },
    // Deliberately no pitch/speakingRate here: Chirp3-HD rejects those parameters, and the
    // dub pipeline already applies the user's pitch/speed via ffmpeg when fitting each
    // segment to its slot, so applying them twice would double up.
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
  });
  return toBuffer(response.audioContent, voice.name);
}

// Voices a line with Gemini-TTS (emotion and delivery follow `style`) and falls back to plain Chirp3-HD whenever Gemini cannot take it.
export async function googleSynthesizeSpeech(
  text: string,
  bcp47: string,
  preferredVoiceName: string,
  gender: string,
  style = '',
  // False when the user chose standard voices.
  allowGemini = true,
  // True when the user turned on premium voices (the paid-extra model).
  premium = false
): Promise<{ audio: Buffer; engine: TtsEngine; model?: string }> {
  const textBytes = Buffer.byteLength(text, 'utf8');
  const fitsGemini = textBytes <= GEMINI_MAX_TEXT_BYTES && textBytes + Buffer.byteLength(style, 'utf8') <= GEMINI_MAX_TOTAL_BYTES;
  if (allowGemini && fitsGemini) {
    for (const model of usableGeminiTtsModels(bcp47, premium)) {
      try {
        const audio = await geminiSynthesize(model, text, bcp47, preferredVoiceName, style);
        geminiRefusals.delete(`${model}|${bcp47}`);
        return { audio, engine: 'gemini', model };
      } catch (err) {
        if (isQuotaError(err)) {
          geminiPausedUntil.set(model, Date.now() + GEMINI_QUOTA_PAUSE_MS);
          log.warn('tts_engine_fallback', { engine: 'gemini', model, reason: 'quota', pauseMs: GEMINI_QUOTA_PAUSE_MS }, `[tts] ${model} out of quota; skipping it for ${GEMINI_QUOTA_PAUSE_MS / 1000}s`);
        } else if (isRefusal(err)) {
          geminiRefusals.set(`${model}|${bcp47}`, (geminiRefusals.get(`${model}|${bcp47}`) ?? 0) + 1);
          log.warn('tts_engine_fallback', { engine: 'gemini', model, reason: 'refused', languageCode: bcp47 }, `[tts] ${model} refused a ${bcp47} line: ${(err as Error)?.message}`);
        } else if (isUnavailableModel(err)) {
          geminiPausedUntil.set(model, Date.now() + GEMINI_UNAVAILABLE_PAUSE_MS);
          log.error('tts_engine_unavailable', err, { engine: 'gemini', model });
        } else {
          throw err;
        }
      }
    }
  }
  return { audio: await chirpSynthesize(text, bcp47, preferredVoiceName, gender), engine: 'chirp' };
}
