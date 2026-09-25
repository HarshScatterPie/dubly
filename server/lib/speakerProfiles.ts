import type { SpeakerProfile, Voice } from '../../src/types';

const GENDERS = new Set(['male', 'female']);
const AGES = new Set(['child', 'young', 'adult', 'senior']);

// A speaker description from transcription, kept only in the shapes the rest of the app understands.
export function cleanSpeakerProfile(raw: unknown): SpeakerProfile | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const gender = String((raw as { gender?: unknown }).gender ?? '').trim().toLowerCase();
  const ageRaw = String((raw as { age?: unknown }).age ?? '').trim().toLowerCase();
  const age = ageRaw.startsWith('young') || ageRaw === 'teen' ? 'young' : ageRaw === 'elderly' || ageRaw === 'old' ? 'senior' : ageRaw;
  const profile: SpeakerProfile = { gender: GENDERS.has(gender) ? (gender as SpeakerProfile['gender']) : 'unknown' };
  if (AGES.has(age)) profile.age = age as SpeakerProfile['age'];
  return profile;
}

// Folds one chunk's speakers into what earlier chunks found: a known gender is never overwritten by a later guess.
export function mergeSpeakerProfiles(into: Record<string, SpeakerProfile>, found: unknown): Record<string, SpeakerProfile> {
  if (!Array.isArray(found)) return into;
  for (const entry of found) {
    const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
    const profile = cleanSpeakerProfile(entry);
    if (!label || !profile) continue;
    const known = into[label];
    if (!known || (known.gender === 'unknown' && profile.gender !== 'unknown')) into[label] = profile;
    else if (!known.age && profile.age) into[label] = { ...known, age: profile.age };
  }
  return into;
}

// Only the speakers that actually speak in the final transcript, so a label dropped by clean-up does not linger.
export function profilesForSpeakers(profiles: Record<string, SpeakerProfile>, speakers: string[]): Record<string, SpeakerProfile> {
  return Object.fromEntries(speakers.filter((s) => profiles[s]).map((s) => [s, profiles[s]]));
}

// A distinct voice of each speaker's own gender; the default voice goes to the first speaker it suits, and unknown genders alternate as before.
export function castVoices(
  speakers: string[],
  profiles: Record<string, SpeakerProfile>,
  catalog: Voice[],
  preferredVoiceId?: string
): Record<string, string> {
  const stock = catalog.filter((v) => v.provider !== 'clone');
  const byGender = (gender: string) => stock.filter((v) => v.gender === gender);
  const used = new Set<string>();
  const preferred = stock.find((v) => v.id === preferredVoiceId);
  let alternate = 0;
  const map: Record<string, string> = {};

  for (const speaker of speakers) {
    const known = profiles[speaker]?.gender;
    const gender = known === 'male' || known === 'female' ? known : alternate++ % 2 === 0 ? 'male' : 'female';
    const pool = byGender(gender).length ? byGender(gender) : stock;
    const choice =
      (preferred && preferred.gender === gender && !used.has(preferred.id) ? preferred : undefined) ??
      pool.find((v) => !used.has(v.id)) ??
      pool[used.size % pool.length];
    if (!choice) continue;
    used.add(choice.id);
    map[speaker] = choice.id;
  }
  return map;
}
