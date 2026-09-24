import { randomUUID } from 'node:crypto';
import type { DubbingProject, LanguageOutput, UserPreferences, UserUsageStats } from '../../src/types';
import { DEFAULT_VOICE_ID, withPreferenceDefaults } from '../../src/data/preferences';
import { db, getSignedDownloadUrl } from './firebaseAdmin';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from './modelRouter';
import { applyPlan, loadProject, planProjectWrite } from './projectStorage';
import { bytesToMb, invalidateStorageUsage, workspaceStorageBytes } from './storageUsage';
import { limits } from './limits';

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
  // The dub job currently allowed to write this project's outputs; absent/null when none is running.
  activeJobId?: string | null;
  dubAttempts?: number;
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

// Projects and the monthly allowance belong to the workspace, so every member sees and spends the same ones.
function projectsCol(workspaceId: string) {
  return db.collection('workspaces').doc(workspaceId).collection('projects');
}

function usageDoc(workspaceId: string) {
  return db.collection('workspaces').doc(workspaceId).collection('meta').doc('usage');
}

// Provider settings stay personal.
function settingsDoc(uid: string) {
  return db.collection('users').doc(uid).collection('meta').doc('settings');
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
  workspaceId: string,
  // The member who created it; kept for display, while access comes from the workspace.
  ownerUid: string,
  data: Partial<StoredProject> & { title: string }
): Promise<StoredProject> {
  const id = `proj-${randomUUID()}`;
  const now = new Date().toISOString();
  const project: StoredProject = {
    id,
    ownerUid,
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
    selectedVoiceId: data.selectedVoiceId || DEFAULT_VOICE_ID,
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
  const ref = projectsCol(workspaceId).doc(id);
  const plan = planProjectWrite(ref, undefined, project);
  await db.runTransaction(async (tx) => applyPlan(tx, ref, plan));
  return project;
}

// Reassembled from its metadata and segment documents (see server/lib/projectStorage.ts).
export async function getStoredProject(workspaceId: string, id: string): Promise<StoredProject | null> {
  return loadProject(projectsCol(workspaceId).doc(id));
}

export async function listStoredProjects(workspaceId: string): Promise<StoredProject[]> {
  const snap = await projectsCol(workspaceId).orderBy('createdAt', 'desc').get();
  const loaded = await Promise.all(snap.docs.map((d) => loadProject(d.ref)));
  return loaded.filter((p): p is StoredProject => p !== null);
}

// Accepts the familiar all-in-one patch; segment fields are written to their own documents, atomically with the rest.
export async function updateStoredProject(
  workspaceId: string,
  id: string,
  patch: Partial<StoredProject>
): Promise<StoredProject> {
  const ref = projectsCol(workspaceId).doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = snap.exists ? (snap.data() as StoredProject) : undefined;
    applyPlan(tx, ref, planProjectWrite(ref, current, { ...patch, updatedAt: new Date().toISOString() }));
  });
  return (await loadProject(ref))!;
}

// Removes the project together with its transcript and per-language documents.
export async function deleteStoredProject(workspaceId: string, id: string): Promise<void> {
  await db.recursiveDelete(projectsCol(workspaceId).doc(id));
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

// Minutes reset on the 1st of every month, India time, since that is where the team and its users are.
const USAGE_TIME_ZONE = 'Asia/Kolkata';

function monthKey(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: USAGE_TIME_ZONE, year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find((p) => p.type === 'year')!.value}-${parts.find((p) => p.type === 'month')!.value}`;
}

// Midnight IST on the 1st of next month, when this month's minutes refresh.
function nextResetIso(date = new Date()): string {
  const [year, month] = monthKey(date).split('-').map(Number);
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return new Date(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01T00:00:00+05:30`).toISOString();
}

type StoredUsage = UserUsageStats & { usagePeriod?: string };

// A stored ledger from an earlier month starts this month at zero minutes; lifetime counters carry over.
function rollUsage(stored: StoredUsage | undefined): StoredUsage {
  const current = { ...DEFAULT_USAGE, ...stored };
  const period = monthKey();
  if (current.usagePeriod !== period) {
    current.minutesDubbed = 0;
    current.usagePeriod = period;
  }
  // The limit is fixed by plan, not by whatever an old document happens to say.
  current.minutesLimit = DEFAULT_USAGE.minutesLimit;
  return current;
}

export async function getUsage(workspaceId: string): Promise<UserUsageStats> {
  const ref = usageDoc(workspaceId);
  const snap = await ref.get();
  const stored = snap.exists ? (snap.data() as StoredUsage) : undefined;
  const usage = rollUsage(stored);
  if (!stored || stored.usagePeriod !== usage.usagePeriod || stored.minutesLimit !== usage.minutesLimit) {
    await ref.set(usage, { merge: true });
  }
  // Storage is measured from the bucket rather than trusted from the old counter; the counter is only a fallback if listing fails.
  const storageUsedMb = await workspaceStorageBytes(workspaceId).then(bytesToMb, () => usage.storageUsedMb);
  return { ...usage, storageUsedMb, storageLimitMb: limits.storageLimitMb, resetsAt: nextResetIso() };
}

export class QuotaExceededError extends Error {}

const roundMinutes = (m: number) => Math.round(m * 10) / 10;

/**
 * Charges a dub's minutes up front, atomically, and refuses it outright if the month's
 * allowance cannot cover it. Charging at the start (and refunding what fails) is what makes
 * the limit strict: two dubs started together cannot both slip under it.
 */
export async function reserveDubMinutes(workspaceId: string, minutes: number): Promise<void> {
  await db.runTransaction(async (tx) => {
    (await prepareReservation(tx, workspaceId, minutes)).commit();
  });
}

// Read half of a reservation inside a larger transaction: checks the allowance now and returns commit() for after the caller reads.
export async function prepareReservation(
  tx: FirebaseFirestore.Transaction,
  workspaceId: string,
  minutes: number
): Promise<{ period: string; commit: () => void }> {
  const ref = usageDoc(workspaceId);
  const snap = await tx.get(ref);
  const usage = rollUsage(snap.exists ? (snap.data() as StoredUsage) : undefined);
  const remaining = roundMinutes(usage.minutesLimit - usage.minutesDubbed);
  if (minutes > remaining + 0.001) {
    const resetDate = new Date(nextResetIso()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: USAGE_TIME_ZONE });
    throw new QuotaExceededError(
      remaining <= 0
        ? `You've used all ${usage.minutesLimit} dubbing minutes for this month. They refresh on ${resetDate}.`
        : `This dub needs ${roundMinutes(minutes)} min but only ${remaining} min are left this month. Dub fewer languages, or wait until ${resetDate}.`
    );
  }
  return {
    period: usage.usagePeriod!,
    commit: () => tx.set(ref, { ...usage, minutesDubbed: roundMinutes(usage.minutesDubbed + minutes) }, { merge: true }),
  };
}

// Gives back minutes for languages that failed; only within the same month, and never below zero.
export async function refundDubMinutes(workspaceId: string, minutes: number, period: string): Promise<void> {
  await db.runTransaction(async (tx) => {
    (await prepareRefund(tx, workspaceId, minutes, period)).commit();
  });
}

// Read half of a refund (see prepareReservation); `refunded` is what will actually be given back, 0 once the month has rolled over.
export async function prepareRefund(
  tx: FirebaseFirestore.Transaction,
  workspaceId: string,
  minutes: number,
  period: string
): Promise<{ refunded: number; commit: () => void }> {
  if (minutes <= 0) return { refunded: 0, commit: () => undefined };
  const ref = usageDoc(workspaceId);
  const snap = await tx.get(ref);
  const usage = rollUsage(snap.exists ? (snap.data() as StoredUsage) : undefined);
  if (usage.usagePeriod !== period) return { refunded: 0, commit: () => undefined };
  const refunded = Math.min(roundMinutes(minutes), usage.minutesDubbed);
  return {
    refunded,
    commit: () => tx.set(ref, { ...usage, minutesDubbed: Math.max(0, roundMinutes(usage.minutesDubbed - minutes)) }, { merge: true }),
  };
}

export function projectRef(workspaceId: string, projectId: string) {
  return projectsCol(workspaceId).doc(projectId);
}

export function currentUsagePeriod(): string {
  return monthKey();
}

// Lifetime counters for a finished language; minutes are already charged by reserveDubMinutes.
export async function recordCompletedDub(
  workspaceId: string,
  opts: { wordsAdded: number; targetLanguageCode: string; fileSizeMb: number }
): Promise<void> {
  const ref = usageDoc(workspaceId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const current = rollUsage(snap.exists ? (snap.data() as StoredUsage) : undefined);
    tx.set(
      ref,
      {
        ...current,
        totalProjects: current.totalProjects + 1,
        wordsTranslated: current.wordsTranslated + opts.wordsAdded,
        languagesUsed: current.languagesUsed + 1,
      },
      { merge: true }
    );
  });
}

// Provider choices plus the user's own defaults; missing fields fall back, so older settings documents read the same.
export interface UserSettings extends ProviderSettings {
  preferences: UserPreferences;
}

function toUserSettings(data: (Partial<ProviderSettings> & { preferences?: Partial<UserPreferences> }) | undefined): UserSettings {
  const { preferences, ...providers } = data ?? {};
  return { ...DEFAULT_PROVIDER_SETTINGS, ...providers, preferences: withPreferenceDefaults(preferences) };
}

export async function getSettings(uid: string): Promise<UserSettings> {
  const snap = await settingsDoc(uid).get();
  return toUserSettings(snap.exists ? snap.data() : undefined);
}

// A merge write: only the fields sent change, including single preferences.
export async function setSettings(
  uid: string,
  settings: Partial<ProviderSettings> & { preferences?: Partial<UserPreferences> }
): Promise<UserSettings> {
  const ref = settingsDoc(uid);
  await ref.set(settings, { merge: true });
  const snap = await ref.get();
  return toUserSettings(snap.data());
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
