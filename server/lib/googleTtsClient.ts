import textToSpeech from '@google-cloud/text-to-speech';
import type { protos } from '@google-cloud/text-to-speech';
import type { VoiceEngine } from '../../src/types';
import { gcpServiceAccountPath, hasGoogleCredentials, useAdc } from './credentials';
import { env } from './env';
import { log } from './log';
import { stripPerformanceTags } from './performance';
import { silenceWav } from './audioUtils';
import { geminiSpeechSynthesize } from './geminiSpeech';

/**
 * Speech synthesis for the voice engines a built-in voice can have:
 *
 * - Gemini 3.8 Flash-Lite and Gemini 3.8 Flash, through the Gemini API (geminiSpeech.ts),
 *   which speak every Indian language and dialect and follow emotion and delivery.
 * - Gemini 2.5 Flash, through Google Cloud Text-to-Speech on the service account, which follows
 *   emotion and delivery in the languages Cloud TTS accepts for Gemini voices.
 * - Chirp 3 HD, through Google Cloud Text-to-Speech (the GA service), a steady voice for the
 *   languages it covers. Cloud TTS also serves the premium Gemini 3.1 model.
 *
 * Gemini-TTS and Chirp3-HD share one voice roster (Aoede, Charon, Kore, ...), so a persona
 * keeps its timbre whichever engine voices it, including when one engine stands in for another.
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

// The Cloud TTS voices for a language, under the locale Google publishes them as.
async function voicesForLanguage(bcp47: string): Promise<{ languageCode: string; voices: IVoice[] }> {
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
  return { languageCode, voices: forLang };
}

// Whether Chirp3-HD itself speaks this language; most regional languages and dialects it does not.
export async function hasChirpVoice(bcp47: string): Promise<boolean> {
  return (await voicesForLanguage(bcp47)).voices.some((v) => (v.name || '').includes('Chirp3-HD'));
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

  const { languageCode, voices: forLang } = await voicesForLanguage(bcp47);
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

// Whether Cloud TTS has any voice at all for the language; with none, only a Gemini voice can speak it.
async function hasAnyVoice(bcp47: string): Promise<boolean> {
  return (await voicesForLanguage(bcp47)).voices.length > 0;
}

export type TtsEngine = 'gemini' | 'chirp';

/** How one line may be voiced: the Gemini models to try, best first, and where Chirp3-HD comes in. */
export interface TtsRoute {
  gemini: string[];
  /**
   * `first`: a Chirp 3 HD voice, with Gemini standing in only for languages Chirp3-HD does
   * not speak. `fallback`: after every Gemini model, so a line is still voiced when Gemini is
   * out of quota or unreachable.
   */
  chirp: 'first' | 'fallback';
}

/**
 * The route for a voice on its (plan-allowed) engine. Gemini stand-ins are only models the
 * plan includes, so a Starter line is voiced by Flash-Lite. Chirp3-HD, the GA voice with
 * production quotas, is every plan's safety net: the same persona voices the line rather
 * than the dub failing (the plan still decides which voices can be picked).
 */
export function ttsRouteFor(engine: VoiceEngine, opts: { premium?: boolean; engines: readonly VoiceEngine[] }): TtsRoute {
  // The operator override voices everything with Chirp3-HD.
  if (env.ttsEngine === 'chirp') return { gemini: [], chirp: 'first' };
  const has = (e: VoiceEngine) => opts.engines.includes(e);
  const lite = has('gemini-flash-lite') ? [env.geminiTtsLiteModel] : [];
  const flash = has('gemini-flash') ? [env.geminiTtsFlashModel] : [];
  const cloud = has('gemini-2.5-flash') ? [env.geminiTtsCloudModel] : [];
  const premium = opts.premium ? [env.geminiTtsPremiumModel] : [];
  const unique = (models: string[]) => [...new Set(models.filter(Boolean))];
  if (engine === 'chirp') return { gemini: unique([...flash, ...lite, ...cloud]), chirp: 'first' };
  if (engine === 'gemini-2.5-flash') return { gemini: unique([env.geminiTtsCloudModel]), chirp: 'fallback' };
  if (engine === 'gemini-flash') return { gemini: unique([...premium, env.geminiTtsFlashModel, ...lite]), chirp: 'fallback' };
  return { gemini: unique([...premium, env.geminiTtsLiteModel]), chirp: 'fallback' };
}

// Cloud TTS Gemini request limits: 4,000 bytes of text, 8,000 of text and prompt together.
const CLOUD_GEMINI_MAX_TEXT_BYTES = 4000;
const CLOUD_GEMINI_MAX_TOTAL_BYTES = 8000;
// Out of quota: hand lines to the next model for a while instead of waiting out a retry on every line of a long dub.
const GEMINI_QUOTA_PAUSE_MS = 90_000;
// Model not enabled or not permitted for this project: an operator has to act, so stop trying for longer.
const GEMINI_UNAVAILABLE_PAUSE_MS = 30 * 60_000;
// A language refused this many times in a row is treated as unsupported; one refusal may just be that line's text.
const GEMINI_REFUSALS_BEFORE_SKIP = 3;

// Per model, so a model out of quota or withdrawn hands over to the next one in the route.
const geminiPausedUntil = new Map<string, number>();
const geminiRefusals = new Map<string, number>();

// Test seam: clears the fallback state between tests.
export function resetGeminiTtsStateForTests(): void {
  geminiPausedUntil.clear();
  geminiRefusals.clear();
}

// Gemini voices on Cloud TTS do not accept every locale Chirp3-HD does; verified: bn-IN, ur-IN and ar-SA are refused, bn-BD, ur-PK and ar-EG are served.
const GEMINI_LOCALES: Record<string, string> = { 'bn-IN': 'bn-BD', 'ur-IN': 'ur-PK', 'ar-SA': 'ar-EG' };

// Locales Gemini voices on Cloud TTS refuse outright (gemini-2.5-flash-tts, checked 2026-09-29); their lines are read by the related language's Gemini voice.
const CLOUD_GEMINI_REFUSED = new Set([
  'as-IN', 'ks-IN', 'mni-IN', 'sat-IN', 'sa-IN', 'doi-IN', 'brx-IN', 'bho-IN', 'bgc-IN',
  'raj-IN', 'awa-IN', 'mag-IN', 'hne-IN', 'bns-IN', 'gbm-IN', 'kfy-IN', 'tcy-IN', 'lus-IN',
]);

export function geminiLocaleFor(bcp47: string): string {
  return GEMINI_LOCALES[bcp47] ?? bcp47;
}

/** The locale a Gemini voice on Cloud TTS reads a line under: its own, else its related language's (Hindi for Bhojpuri), else none. */
export function cloudGeminiLocale(bcp47: string, relatedBcp47?: string): string | null {
  if (!CLOUD_GEMINI_REFUSED.has(bcp47)) return geminiLocaleFor(bcp47);
  return relatedBcp47 && !CLOUD_GEMINI_REFUSED.has(relatedBcp47) ? geminiLocaleFor(relatedBcp47) : null;
}

// The Gemini 2.5 Flash and premium models are served by Cloud TTS; the 3.8 models are on the Gemini API.
function servedByCloudTts(model: string): boolean {
  return model === env.geminiTtsPremiumModel || model === env.geminiTtsCloudModel;
}

function fitsCloudGemini(text: string, style: string): boolean {
  const textBytes = Buffer.byteLength(text, 'utf8');
  return textBytes <= CLOUD_GEMINI_MAX_TEXT_BYTES && textBytes + Buffer.byteLength(style, 'utf8') <= CLOUD_GEMINI_MAX_TOTAL_BYTES;
}

function modelUsable(model: string, bcp47: string): boolean {
  return Date.now() >= (geminiPausedUntil.get(model) ?? 0) && (geminiRefusals.get(`${model}|${bcp47}`) ?? 0) < GEMINI_REFUSALS_BEFORE_SKIP;
}

// The route's models that would take a line in this language right now, in the order they are tried; the router reads the cache in the same order.
export function usableGeminiTtsModels(route: TtsRoute, bcp47: string): string[] {
  return route.gemini.filter((model) => modelUsable(model, bcp47));
}

function grpcCode(err: unknown): number | undefined {
  const code = (err as { code?: unknown })?.code;
  return typeof code === 'number' ? code : undefined;
}

// The HTTP status the Gemini API answered with, when the error came from there.
function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}

// gRPC status codes (Cloud TTS) or HTTP statuses (Gemini API), matched by number or by the name in the message.
function isQuotaError(err: unknown): boolean {
  return grpcCode(err) === 8 || httpStatus(err) === 429 || /RESOURCE_EXHAUSTED|quota/i.test(String((err as Error)?.message ?? err));
}
function isRefusal(err: unknown): boolean {
  return grpcCode(err) === 3 || httpStatus(err) === 400 || /INVALID_ARGUMENT/i.test(String((err as Error)?.message ?? err));
}
function isUnavailableModel(err: unknown): boolean {
  const code = grpcCode(err);
  const status = httpStatus(err);
  return (
    code === 5 || code === 7 || code === 9 || code === 12 || status === 403 || status === 404 ||
    /PERMISSION_DENIED|NOT_FOUND|FAILED_PRECONDITION|UNIMPLEMENTED/i.test(String((err as Error)?.message ?? err))
  );
}

function toBuffer(audio: Uint8Array | string | null | undefined, voiceName: string): Buffer {
  if (!audio) throw new Error(`Google Cloud TTS returned no audio for voice ${voiceName}`);
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio as Uint8Array);
}

// A Gemini model on Cloud TTS, under a locale it accepts (see cloudGeminiLocale); the persona is passed as is.
async function cloudGeminiSynthesize(model: string, text: string, locale: string, voiceName: string, style: string): Promise<Buffer> {
  const [response] = await getClient().synthesizeSpeech({
    input: style ? { text, prompt: style } : { text },
    voice: { languageCode: locale, name: voiceName, modelName: model },
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

/**
 * Voices a line along its route. Gemini models are tried best first (emotion and delivery
 * follow `style`); one out of quota, withdrawn, or refusing the language hands the line to
 * the next, and Chirp3-HD voices whatever none of them could.
 *
 * `chirpFallbackBcp47` is the related language whose Chirp3-HD voices read this one's script
 * (Hindi for Bhojpuri, Bengali for Assamese...), for languages Chirp3-HD does not speak itself.
 */
export async function googleSynthesizeSpeech(
  text: string,
  bcp47: string,
  preferredVoiceName: string,
  gender: string,
  style: string,
  route: TtsRoute,
  chirpFallbackBcp47?: string
): Promise<{ audio: Buffer; engine: TtsEngine; model?: string }> {
  const chirp = async () => {
    const locale = !chirpFallbackBcp47 || (await hasChirpVoice(bcp47)) ? bcp47 : chirpFallbackBcp47;
    return { audio: await chirpSynthesize(text, locale, preferredVoiceName, gender), engine: 'chirp' as const };
  };
  // A Chirp 3 HD voice speaks its own languages itself; Gemini stands in for the rest, where it sounds native.
  if (route.gemini.length === 0 || (route.chirp === 'first' && (await hasChirpVoice(bcp47)))) return chirp();

  // With no Cloud TTS voice to fall back on (Odia), a paused model is still tried, and running out of quota goes back to the caller, whose retry waits for it to refill.
  const onlyGemini = !(await hasAnyVoice(bcp47)) && !(chirpFallbackBcp47 && (await hasAnyVoice(chirpFallbackBcp47)));
  let quotaError: unknown = null;
  for (const model of onlyGemini ? route.gemini : usableGeminiTtsModels(route, bcp47)) {
    const cloud = servedByCloudTts(model);
    const locale = cloud ? cloudGeminiLocale(bcp47, chirpFallbackBcp47) : bcp47;
    if (!locale || (cloud && !fitsCloudGemini(text, style))) continue;
    try {
      const audio = cloud
        ? await cloudGeminiSynthesize(model, text, locale, preferredVoiceName, style)
        : await geminiSpeechSynthesize(model, text, preferredVoiceName, style);
      geminiRefusals.delete(`${model}|${bcp47}`);
      return { audio, engine: 'gemini', model };
    } catch (err) {
      if (isQuotaError(err)) {
        quotaError = err;
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
  if (onlyGemini && quotaError) throw quotaError;
  return chirp();
}
