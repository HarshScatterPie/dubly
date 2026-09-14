import textToSpeech from '@google-cloud/text-to-speech';
import type { protos } from '@google-cloud/text-to-speech';
import { gcpServiceAccountPath, hasCredentialFile } from './credentials';

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
  return hasCredentialFile('gcp-service-account.json');
}

function getClient() {
  if (!client) {
    if (!isGoogleTtsConfigured()) {
      throw new Error('Google Cloud TTS is not configured (missing gcp-service-account.json)');
    }
    client = new textToSpeech.TextToSpeechClient({ keyFilename: gcpServiceAccountPath });
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

export async function googleSynthesizeSpeech(
  text: string,
  bcp47: string,
  preferredVoiceName: string,
  gender: string
): Promise<Buffer> {
  const voice = await resolveVoice(bcp47, preferredVoiceName, gender);
  const [response] = await getClient().synthesizeSpeech({
    input: { text },
    voice: { languageCode: voice.languageCode, name: voice.name },
    // Deliberately no pitch/speakingRate here: Chirp3-HD rejects those parameters, and the
    // dub pipeline already applies the user's pitch/speed via ffmpeg when fitting each
    // segment to its slot, so applying them twice would double up.
    audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 24000 },
  });

  const audio = response.audioContent;
  if (!audio) {
    throw new Error(`Google Cloud TTS returned no audio for voice ${voice.name}`);
  }
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio);
}
