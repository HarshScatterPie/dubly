import { randomUUID } from 'node:crypto';
import type { CustomVoice, Voice } from '../../src/types';
import { db, getSignedDownloadUrl } from './firebaseAdmin';

/** A user's cloned voice as stored: the sample's path, not a signed URL that would expire. */
export interface StoredCustomVoice extends Omit<CustomVoice, 'sampleAudioUrl'> {
  ownerUid: string;
  sampleStoragePath: string;
}

/**
 * Cloned-voice ids are prefixed so they can never collide with the built-in catalog, and
 * so any code holding a bare id can tell the two apart without a lookup.
 */
export const CLONED_VOICE_PREFIX = 'cloned:';

export function isClonedVoiceId(voiceId: string): boolean {
  return voiceId.startsWith(CLONED_VOICE_PREFIX);
}

function voicesCol(uid: string) {
  return db.collection('users').doc(uid).collection('voices');
}

/** Mints the id up front so the caller can name the sample's storage folder after it. */
export function newCustomVoiceId(): string {
  return `${CLONED_VOICE_PREFIX}${randomUUID()}`;
}

export async function createCustomVoice(
  uid: string,
  data: {
    id?: string;
    name: string;
    sampleStoragePath: string;
    sampleTranscript: string;
    languageCode: string;
    gender: CustomVoice['gender'];
  }
): Promise<StoredCustomVoice> {
  const voice: StoredCustomVoice = {
    id: data.id || newCustomVoiceId(),
    ownerUid: uid,
    name: data.name,
    gender: data.gender,
    languageCode: data.languageCode,
    sampleStoragePath: data.sampleStoragePath,
    sampleTranscript: data.sampleTranscript,
    createdAt: new Date().toISOString(),
  };
  await voicesCol(uid).doc(voice.id).set(voice);
  return voice;
}

export async function listCustomVoices(uid: string): Promise<StoredCustomVoice[]> {
  const snap = await voicesCol(uid).orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => d.data() as StoredCustomVoice);
}

export async function getCustomVoice(uid: string, voiceId: string): Promise<StoredCustomVoice | null> {
  const snap = await voicesCol(uid).doc(voiceId).get();
  if (!snap.exists) return null;
  const voice = snap.data() as StoredCustomVoice;
  return voice.ownerUid === uid ? voice : null;
}

export async function deleteCustomVoice(uid: string, voiceId: string): Promise<void> {
  await voicesCol(uid).doc(voiceId).delete();
}

export async function toClientCustomVoice(stored: StoredCustomVoice): Promise<CustomVoice> {
  const { ownerUid, sampleStoragePath, ...rest } = stored;
  return { ...rest, sampleAudioUrl: await getSignedDownloadUrl(sampleStoragePath) };
}

/**
 * Presents a cloned voice in the same shape as a catalog voice.
 *
 * Everything downstream — the router, the TTS cache, the per-language voice resolution,
 * the dub pipeline — is written against `Voice`. Adapting here means a cloned voice is
 * selectable anywhere a built-in one is, with no branching in any of those places; only
 * the synthesis call itself checks `provider === 'clone'`.
 */
export function toVoice(stored: StoredCustomVoice): Voice {
  return {
    id: stored.id,
    name: stored.name,
    gender: stored.gender,
    languageCode: stored.languageCode,
    languageName: 'Your voice',
    accent: 'Cloned from your recording',
    category: 'conversational',
    description: 'A voice cloned from a recording you uploaded.',
    avatarUrl: '',
    sampleQuote: stored.sampleTranscript,
    tags: ['Your voice', 'Cloned'],
    pitch: 1,
    speed: 1,
    provider: 'clone',
    providerVoice: { clone: stored.id },
  };
}

/**
 * The full set of voices available to one user: the shared catalog plus their own clones.
 * Callers resolve voice ids against this rather than the static catalog, or a cloned voice
 * would look like an unknown id.
 */
export async function voiceCatalogFor(uid: string, builtIn: Voice[]): Promise<Voice[]> {
  const custom = await listCustomVoices(uid);
  return [...builtIn, ...custom.map(toVoice)];
}

export interface CloneReference {
  audioPath: string;
  transcript?: string;
}

/**
 * Pulls a cloned voice's reference recording onto local disk, where the Python engine can
 * read it, and remembers it for the rest of the job.
 *
 * A dub calls this once per line; without the cache that would be one storage download per
 * line of dialogue, for a file that never changes within a render.
 */
export function createReferenceLoader(uid: string, workDir: string) {
  const cache = new Map<string, Promise<CloneReference>>();

  return function loadReference(voiceId: string): Promise<CloneReference> {
    const existing = cache.get(voiceId);
    if (existing) return existing;

    const loading = (async () => {
      const voice = await getCustomVoice(uid, voiceId);
      if (!voice) throw new Error(`Cloned voice ${voiceId} no longer exists`);
      const { mkdir } = await import('node:fs/promises');
      const { bucket } = await import('./firebaseAdmin');
      const nodePath = await import('node:path');

      const dir = nodePath.join(workDir, 'clone-refs');
      await mkdir(dir, { recursive: true });
      // The id carries a `cloned:` prefix and a UUID; the colon is not a legal Windows
      // filename character, so it is stripped rather than used verbatim.
      const localPath = nodePath.join(dir, `${voiceId.replace(/[^a-zA-Z0-9_-]/g, '_')}.wav`);
      await bucket.file(voice.sampleStoragePath).download({ destination: localPath });
      return { audioPath: localPath, transcript: voice.sampleTranscript };
    })();

    cache.set(voiceId, loading);
    return loading;
  };
}
