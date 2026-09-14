import { randomUUID } from 'node:crypto';
import type { DubbingProject, LanguageOutput, UserUsageStats } from '../../src/types';
import { db, getSignedDownloadUrl } from './firebaseAdmin';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from './modelRouter';

/** A language output as stored: paths, not the signed URLs the client gets. */
export interface StoredLanguageOutput extends Omit<LanguageOutput, 'dubbedAudioUrl' | 'finalDubbedVideoUrl'> {
  dubbedAudioStoragePath?: string;
  finalDubbedVideoStoragePath?: string;
}

/**
 * Firestore stores bucket-relative storage paths, never signed URLs (those expire).
 * A fresh signed URL is minted from the stored path every time a project is read.
 */
export interface StoredProject
  extends Omit<
    DubbingProject,
    'videoUrl' | 'dubbedAudioUrl' | 'finalDubbedVideoUrl' | 'videoThumbnailUrl' | 'languageOutputs'
  > {
  ownerUid: string;
  videoStoragePath?: string;
  dubbedAudioStoragePath?: string;
  finalDubbedVideoStoragePath?: string;
  videoThumbnailStoragePath?: string;
  languageOutputs?: Record<string, StoredLanguageOutput>;
}

/**
 * The languages a project targets, primary first.
 *
 * Projects created before multi-language dubbing have no `targetLanguages`, so this falls
 * back to the single `targetLanguage` — every caller can then treat the two eras of
 * project the same way instead of branching on which one it is holding.
 */
export function projectLanguages(stored: Pick<StoredProject, 'targetLanguage' | 'targetLanguages'>): string[] {
  const list = stored.targetLanguages?.length ? stored.targetLanguages : [stored.targetLanguage];
  return list.filter(Boolean);
}

/**
 * A language's localized segments, wherever they live.
 *
 * The primary language's segments are kept at the top level (that is what the workspace,
 * the caption burner and every pre-multi-language reader look at); the rest live in
 * `languageOutputs`. Both are read through here so callers never have to know which.
 */
export function segmentsForLanguage(
  stored: Pick<StoredProject, 'targetLanguage' | 'localizedSegments' | 'languageOutputs'>,
  languageCode: string
): DubbingProject['localizedSegments'] {
  if (languageCode === stored.targetLanguage && stored.localizedSegments?.length) {
    return stored.localizedSegments;
  }
  return stored.languageOutputs?.[languageCode]?.localizedSegments || [];
}

function projectsCol(uid: string) {
  return db.collection('users').doc(uid).collection('projects');
}

function metaDoc(uid: string, name: 'usage' | 'settings') {
  return db.collection('users').doc(uid).collection('meta').doc(name);
}

export async function toClientProject(stored: StoredProject): Promise<DubbingProject> {
  const [videoUrl, dubbedAudioUrl, finalDubbedVideoUrl, videoThumbnailUrl] = await Promise.all([
    stored.videoStoragePath ? getSignedDownloadUrl(stored.videoStoragePath) : Promise.resolve(''),
    stored.dubbedAudioStoragePath ? getSignedDownloadUrl(stored.dubbedAudioStoragePath) : Promise.resolve(undefined),
    stored.finalDubbedVideoStoragePath
      ? getSignedDownloadUrl(stored.finalDubbedVideoStoragePath)
      : Promise.resolve(undefined),
    stored.videoThumbnailStoragePath ? getSignedDownloadUrl(stored.videoThumbnailStoragePath) : Promise.resolve(''),
  ]);

  const {
    ownerUid,
    videoStoragePath,
    dubbedAudioStoragePath,
    finalDubbedVideoStoragePath,
    videoThumbnailStoragePath,
    languageOutputs,
    ...rest
  } = stored;

  return {
    ...rest,
    videoUrl,
    dubbedAudioUrl,
    finalDubbedVideoUrl,
    videoThumbnailUrl,
    languageOutputs: await toClientLanguageOutputs(languageOutputs),
  };
}

/** Same path -> signed URL swap as above, for every language a project renders into. */
async function toClientLanguageOutputs(
  outputs: Record<string, StoredLanguageOutput> | undefined
): Promise<Record<string, LanguageOutput> | undefined> {
  if (!outputs) return undefined;
  const entries = await Promise.all(
    Object.entries(outputs).map(async ([code, out]) => {
      const { dubbedAudioStoragePath, finalDubbedVideoStoragePath, ...rest } = out;
      const [dubbedAudioUrl, finalDubbedVideoUrl] = await Promise.all([
        dubbedAudioStoragePath ? getSignedDownloadUrl(dubbedAudioStoragePath) : Promise.resolve(undefined),
        finalDubbedVideoStoragePath ? getSignedDownloadUrl(finalDubbedVideoStoragePath) : Promise.resolve(undefined),
      ]);
      return [code, { ...rest, dubbedAudioUrl, finalDubbedVideoUrl }] as const;
    })
  );
  return Object.fromEntries(entries);
}

export async function createProject(
  uid: string,
  data: Partial<StoredProject> & { title: string }
): Promise<StoredProject> {
  const id = `proj-${randomUUID()}`;
  const now = new Date().toISOString();
  const project: StoredProject = {
    id,
    ownerUid: uid,
    title: data.title,
    videoStoragePath: undefined,
    videoThumbnailStoragePath: undefined,
    videoFileName: data.videoFileName || '',
    videoDuration: data.videoDuration || 0,
    videoResolution: data.videoResolution || '',
    videoFileSize: data.videoFileSize || '',
    sourceLanguage: data.sourceLanguage || 'en',
    targetLanguage: data.targetLanguage || 'hi',
    targetLanguages: data.targetLanguages?.length ? data.targetLanguages : [data.targetLanguage || 'hi'],
    languageOutputs: data.languageOutputs || {},
    selectedVoiceId: data.selectedVoiceId || 'riya',
    languageVoiceMap: data.languageVoiceMap || {},
    languageSpeakerVoiceMap: data.languageSpeakerVoiceMap || {},
    translationStyle: data.translationStyle || 'natural',
    adaptExpressions: data.adaptExpressions ?? true,
    autoLipSync: data.autoLipSync ?? false,
    voiceSpeed: data.voiceSpeed ?? 1.0,
    voicePitch: data.voicePitch ?? 1.0,
    voiceEmotion: data.voiceEmotion || 'friendly',
    transcriptSegments: data.transcriptSegments || [],
    localizedSegments: data.localizedSegments || [],
    status: data.status || 'draft',
    currentStep: data.currentStep || 'upload',
    progressPercent: data.progressPercent || 0,
    currentProcessingMessage: data.currentProcessingMessage,
    createdAt: now,
    updatedAt: now,
    wordsCount: data.wordsCount || 0,
    speakersCount: data.speakersCount || 1,
  };
  await projectsCol(uid).doc(id).set(project);
  return project;
}

export async function getStoredProject(uid: string, id: string): Promise<StoredProject | null> {
  const snap = await projectsCol(uid).doc(id).get();
  return snap.exists ? (snap.data() as StoredProject) : null;
}

export async function listStoredProjects(uid: string): Promise<StoredProject[]> {
  const snap = await projectsCol(uid).orderBy('createdAt', 'desc').get();
  return snap.docs.map((d) => d.data() as StoredProject);
}

export async function updateStoredProject(
  uid: string,
  id: string,
  patch: Partial<StoredProject>
): Promise<StoredProject> {
  const ref = projectsCol(uid).doc(id);
  const merged = { ...patch, updatedAt: new Date().toISOString() };
  await ref.set(merged, { merge: true });
  const snap = await ref.get();
  return snap.data() as StoredProject;
}

export async function deleteStoredProject(uid: string, id: string): Promise<void> {
  await projectsCol(uid).doc(id).delete();
}

const DEFAULT_USAGE: UserUsageStats = {
  minutesDubbed: 0,
  minutesLimit: 120,
  totalProjects: 0,
  storageUsedMb: 0,
  storageLimitMb: 2048,
  languagesUsed: 0,
  wordsTranslated: 0,
  activePlan: 'Starter',
};

export async function getUsage(uid: string): Promise<UserUsageStats> {
  const snap = await metaDoc(uid, 'usage').get();
  if (!snap.exists) {
    await metaDoc(uid, 'usage').set(DEFAULT_USAGE);
    return DEFAULT_USAGE;
  }
  return snap.data() as UserUsageStats;
}

export async function recordCompletedDub(
  uid: string,
  opts: { minutesAdded: number; wordsAdded: number; targetLanguageCode: string; fileSizeMb: number }
): Promise<void> {
  const ref = metaDoc(uid, 'usage');
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = (snap.exists ? (snap.data() as UserUsageStats) : DEFAULT_USAGE);
    const langSet = new Set<string>();
    // languagesUsed is a simple counter; we don't track the historical set server-side
    // beyond this increment, so re-dubbing the same language still nudges it — acceptable
    // for a usage *estimate* widget rather than a precise ledger.
    tx.set(
      ref,
      {
        ...current,
        minutesDubbed: Math.round((current.minutesDubbed + opts.minutesAdded) * 10) / 10,
        totalProjects: current.totalProjects + 1,
        wordsTranslated: current.wordsTranslated + opts.wordsAdded,
        storageUsedMb: Math.round((current.storageUsedMb + opts.fileSizeMb) * 10) / 10,
        languagesUsed: current.languagesUsed + (langSet.has(opts.targetLanguageCode) ? 0 : 1),
      },
      { merge: true }
    );
  });
}

export async function getSettings(uid: string): Promise<ProviderSettings> {
  const snap = await metaDoc(uid, 'settings').get();
  if (!snap.exists) return DEFAULT_PROVIDER_SETTINGS;
  return { ...DEFAULT_PROVIDER_SETTINGS, ...(snap.data() as Partial<ProviderSettings>) };
}

export async function setSettings(uid: string, settings: Partial<ProviderSettings>): Promise<ProviderSettings> {
  const ref = metaDoc(uid, 'settings');
  await ref.set(settings, { merge: true });
  const snap = await ref.get();
  return { ...DEFAULT_PROVIDER_SETTINGS, ...(snap.data() as Partial<ProviderSettings>) };
}

export interface UserProfile {
  name: string;
  role: string;
  workspace: string;
}

/**
 * Reads the user's profile from `users/{uid}` directly — the parent doc, not one of Dubly's
 * own subcollections under it. This project's Firestore is shared with the rest of
 * ScatterStudio, and that doc (name/role/workspace/api_key/...) is provisioned by whatever
 * ScatterStudio's own onboarding is, not by Dubly. Firebase Auth's displayName is usually
 * empty (only Google sign-in ever fills it), so this is the actual source of truth for a
 * user's name here — and the one other ScatterStudio tools already show.
 *
 * Deliberately whitelists fields rather than returning the doc as-is: it also holds
 * `api_key`, which must never reach the client.
 */
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const snap = await db.collection('users').doc(uid).get();
  if (!snap.exists) return null;
  const data = snap.data() || {};
  return {
    name: typeof data.name === 'string' ? data.name : '',
    role: typeof data.role === 'string' ? data.role : '',
    workspace: typeof data.workspace === 'string' ? data.workspace : '',
  };
}
