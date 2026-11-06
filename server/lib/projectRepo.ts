import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongodb';
import type { DubbingProject, LanguageOutput, Plan, SegmentCounts, UserPreferences, UserUsageStats } from '../../src/types';
import { DEFAULT_VOICE_ID, withPreferenceDefaults } from '../../src/data/preferences';
import { col, mergeUpdate, withTransaction } from './mongo';
import { getSignedDownloadUrl } from './mediaStore';
import { getUser, updateUserProfile } from './accounts';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from './modelRouter';
import { applyPlan, deleteProjectDocuments, insertPlan, loadProject, loadProjectMeta, loadProjectSummaries, loadProjects, planProjectWrite, projectsCol } from './projectStorage';
import { bytesToMb, invalidateStorageUsage, workspaceStorageBytes } from './storageUsage';
import { limits } from './limits';
import { DEFAULT_PLANS, planForWorkspace } from './plans';

/** A language output as stored: paths, not the signed URLs the client gets. */
export interface StoredLanguageOutput extends Omit<LanguageOutput, 'dubbedAudioUrl' | 'finalDubbedVideoUrl'> {
  dubbedAudioStoragePath?: string;
  finalDubbedVideoStoragePath?: string;
}

/**
 * Records store storage paths (GridFS filenames), never signed URLs (those expire).
 * A signed URL is minted from the stored path every time a project is read.
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
  // Separated stems of the current source, kept so a retake or another language skips the (slow) separation.
  stemsCache?: StemsCache;
  segmentCounts?: SegmentCounts;
}

export interface StemsCache {
  sourcePath: string;
  model: string;
  backgroundPath: string;
  vocalsPath: string;
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

// The monthly allowance belongs to the workspace (usage/{workspaceId}), so every member sees and spends the same one.
const usageCol = () => col<StoredUsage & { _id: string }>('usage');
// Provider settings stay personal (userSettings/{uid}).
const settingsCol = () => col<Record<string, unknown> & { _id: string }>('userSettings');

// A listed project as the client gets it: marked as a summary, so it is opened through GET /api/projects/:id.
export async function toClientSummary(stored: StoredProject): Promise<DubbingProject> {
  return { ...(await toClientProject(stored)), summary: true };
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
    stemsCache: _stems,
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
  const plan = planProjectWrite(workspaceId, id, undefined, project);
  await withTransaction((session) => insertPlan(workspaceId, id, plan, session));
  return project;
}

// Reassembled from its metadata and segment documents (see server/lib/projectStorage.ts).
export async function getStoredProject(workspaceId: string, id: string): Promise<StoredProject | null> {
  return loadProject(workspaceId, id);
}

/** What a progress bar needs from a project; the same fields, with the same meaning, as in the full project. */
export type ProjectProgress = Pick<DubbingProject, 'status' | 'progressPercent' | 'currentProcessingMessage' | 'updatedAt'>;

/**
 * The progress of a project from a single document read, with only those four fields fetched. The UI polls every second or so
 * while a dub runs, and the full project costs a read per language plus the transcript, signed URLs and the whole transcript in the answer.
 */
export async function getProjectProgress(workspaceId: string, id: string): Promise<ProjectProgress | null> {
  const data = (await projectsCol().findOne(
    { _id: id, workspaceId },
    { projection: { _id: 0, status: 1, progressPercent: 1, currentProcessingMessage: 1, updatedAt: 1 } }
  )) as Partial<ProjectProgress> | null;
  if (!data) return null;
  return {
    status: data.status ?? 'draft',
    progressPercent: data.progressPercent ?? 0,
    // A cleared message is stored as null; the full project leaves it out, and so does this.
    currentProcessingMessage: data.currentProcessingMessage ?? undefined,
    updatedAt: data.updatedAt ?? '',
  };
}

// The workspace's projects without their lines, for lists; a project's lines come with getStoredProject.
export async function listProjectSummaries(workspaceId: string): Promise<StoredProject[]> {
  return loadProjectSummaries(workspaceId);
}

export async function listStoredProjects(workspaceId: string): Promise<StoredProject[]> {
  const docs = await projectsCol().find({ workspaceId }).sort({ createdAt: -1 }).toArray();
  return loadProjects(workspaceId, docs);
}

// Accepts the familiar all-in-one patch; segment fields are written to their own documents, atomically with the rest.
export async function updateStoredProject(
  workspaceId: string,
  id: string,
  patch: Partial<StoredProject>
): Promise<StoredProject> {
  await withTransaction(async (session) => {
    const current = await loadProjectMeta(workspaceId, id, session);
    if (!current) return;
    await applyPlan(workspaceId, id, planProjectWrite(workspaceId, id, current, { ...patch, updatedAt: new Date().toISOString() }), session);
  });
  return (await loadProject(workspaceId, id))!;
}

// Removes the project together with its transcript and per-language documents.
export async function deleteStoredProject(workspaceId: string, id: string): Promise<void> {
  await withTransaction((session) => deleteProjectDocuments(workspaceId, id, session));
}

const DEFAULT_USAGE: UserUsageStats = {
  minutesDubbed: 0,
  minutesLimit: DEFAULT_PLANS.starter.minutesPerMonth,
  renewsMonthly: true,
  totalProjects: 0,
  storageUsedMb: 0,
  storageLimitMb: 2048,
  languagesUsed: 0,
  wordsTranslated: 0,
  activePlan: DEFAULT_PLANS.starter.name,
  planId: 'starter',
  paidExtrasAllowed: false,
  extraRates: DEFAULT_PLANS.starter.extraRates,
  teamInvites: false,
  voiceEngines: DEFAULT_PLANS.starter.voiceEngines,
};

// Taken from the workspace's plan on every read, never trusted from (or written to) the usage document.
const PLAN_FIELDS = ['minutesLimit', 'renewsMonthly', 'activePlan', 'planId', 'paidExtrasAllowed', 'extraRates', 'teamInvites', 'voiceEngines'] as const;

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

// voiceSecondsCarry: seconds of voice clips not yet charged, because the ledger counts minutes in tenths (see settleVoiceMinutes).
// alerts: the usage period each usage email was last sent for (notifications.ts), written only by that module.
type StoredUsage = UserUsageStats & { usagePeriod?: string; voiceSecondsCarry?: number; alerts?: Record<string, string> };

// The usage period of a plan whose allowance is a one-time total (Free): it never rolls over.
const LIFETIME_PERIOD = 'lifetime';
const periodFor = (plan: Plan) => (plan.renewsMonthly ? monthKey() : LIFETIME_PERIOD);

// A stored ledger from an earlier period starts at zero minutes (a new month, or a move between Free and a monthly plan); lifetime counters
// carry over, and the limit comes from the plan.
function rollUsage(stored: StoredUsage | undefined, plan: Plan): StoredUsage {
  const current = { ...DEFAULT_USAGE, ...stored };
  const period = periodFor(plan);
  if (current.usagePeriod !== period) {
    current.minutesDubbed = 0;
    current.voiceSecondsCarry = 0;
    current.usagePeriod = period;
  }
  return {
    ...current,
    minutesLimit: plan.minutesPerMonth,
    renewsMonthly: plan.renewsMonthly,
    activePlan: plan.name,
    planId: plan.id,
    paidExtrasAllowed: plan.paidExtras,
    extraRates: plan.extraRates,
    teamInvites: plan.teamInvites,
    voiceEngines: plan.voiceEngines,
  };
}

// The ledger as stored: the month's minutes and lifetime counters, without anything the plan decides.
function ledgerOf(usage: StoredUsage): Partial<StoredUsage> {
  const ledger: Partial<StoredUsage> = { ...usage };
  for (const field of PLAN_FIELDS) delete ledger[field];
  // Never written back from a read: a charge running beside an alert must not undo its mark.
  delete ledger.alerts;
  return ledger;
}

// The stored ledger, without the database's own key; read inside the caller's transaction when there is one.
async function readUsage(workspaceId: string, session?: ClientSession): Promise<StoredUsage | undefined> {
  return ((await usageCol().findOne({ _id: workspaceId }, { session, projection: { _id: 0 } })) as StoredUsage | null) ?? undefined;
}

async function writeUsage(workspaceId: string, fields: Partial<StoredUsage>, session?: ClientSession): Promise<void> {
  const update = mergeUpdate(fields as Record<string, unknown>);
  if (update.$set || update.$unset) await usageCol().updateOne({ _id: workspaceId }, update, { upsert: true, session });
}

export async function getUsage(workspaceId: string): Promise<UserUsageStats> {
  const [stored, plan] = await Promise.all([readUsage(workspaceId), planForWorkspace(workspaceId)]);
  const usage = rollUsage(stored, plan);
  if (!stored || stored.usagePeriod !== usage.usagePeriod) {
    await writeUsage(workspaceId, ledgerOf(usage));
  }
  // Storage is measured from GridFS rather than trusted from the old counter; the counter is only a fallback if measuring fails.
  const storageUsedMb = await workspaceStorageBytes(workspaceId).then(bytesToMb, () => usage.storageUsedMb);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { voiceSecondsCarry, ...shown } = usage;
  return { ...shown, storageUsedMb, storageLimitMb: limits.storageLimitMb, ...(plan.renewsMonthly ? { resetsAt: nextResetIso() } : {}) };
}

export class QuotaExceededError extends Error {}

const roundMinutes = (m: number) => Math.round(m * 10) / 10;

/**
 * Charges a dub's minutes up front, atomically, and refuses it outright if the month's
 * allowance cannot cover it. Charging at the start (and refunding what fails) is what makes
 * the limit strict: two dubs started together cannot both slip under it.
 */
export async function reserveDubMinutes(workspaceId: string, minutes: number): Promise<void> {
  await withTransaction(async (session) => {
    await (await prepareReservation(session, workspaceId, minutes)).commit();
  });
  afterCharge(workspaceId);
}

// How a refusal names what needed the minutes, and what the person can do instead.
interface ChargeWording {
  needs: (minutes: number) => string;
  instead: string;
}
const DUB_WORDING: ChargeWording = { needs: (m) => `This dub needs ${m} min`, instead: 'Dub fewer languages' };
const VOICE_WORDING: ChargeWording = { needs: (m) => `This voice clip needs up to ${m} min`, instead: 'Use a shorter text' };
const VIDEO_WORDING: ChargeWording = { needs: (m) => `Dubbing this video needs ${m} min`, instead: 'Use a shorter video' };

// Throws the refusal when `minutes` is more than the allowance has left.
function assertCovered(usage: StoredUsage, plan: Plan, minutes: number, wording: ChargeWording): void {
  const remaining = roundMinutes(usage.minutesLimit - usage.minutesDubbed);
  if (minutes <= remaining + 0.001) return;
  if (!plan.renewsMonthly) {
    throw new QuotaExceededError(
      remaining <= 0
        ? `You've used all ${usage.minutesLimit} free dubbing minutes. Request a quota increase on the Usage page to keep dubbing.`
        : `${wording.needs(roundMinutes(minutes))} but only ${remaining} free min are left. ${wording.instead}, or request a quota increase on the Usage page.`
    );
  }
  const resetDate = new Date(nextResetIso()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: USAGE_TIME_ZONE });
  throw new QuotaExceededError(
    remaining <= 0
      ? `You've used all ${usage.minutesLimit} dubbing minutes for this month. They refresh on ${resetDate}.`
      : `${wording.needs(roundMinutes(minutes))} but only ${remaining} min are left this month. ${wording.instead}, or wait until ${resetDate}.`
  );
}

// Read half of a reservation inside a larger transaction: checks the allowance now and returns commit() for after the caller reads.
export async function prepareReservation(
  session: ClientSession,
  workspaceId: string,
  minutes: number,
  wording: ChargeWording = DUB_WORDING
): Promise<{ period: string; commit: () => Promise<void> }> {
  const plan = await planForWorkspace(workspaceId);
  const usage = rollUsage(await readUsage(workspaceId, session), plan);
  assertCovered(usage, plan, minutes, wording);
  return {
    period: usage.usagePeriod!,
    commit: () => writeUsage(workspaceId, { ...ledgerOf(usage), minutesDubbed: roundMinutes(usage.minutesDubbed + minutes) }, session),
  };
}

// Gives back minutes for languages that failed; only within the same month, and never below zero.
export async function refundDubMinutes(workspaceId: string, minutes: number, period: string): Promise<void> {
  await withTransaction(async (session) => {
    await (await prepareRefund(session, workspaceId, minutes, period)).commit();
  });
}

// Read half of a refund (see prepareReservation); `refunded` is what will actually be given back, 0 once the month has rolled over.
export async function prepareRefund(
  session: ClientSession,
  workspaceId: string,
  minutes: number,
  period: string
): Promise<{ refunded: number; commit: () => Promise<void> }> {
  const nothing = async () => undefined;
  if (minutes <= 0) return { refunded: 0, commit: nothing };
  const plan = await planForWorkspace(workspaceId);
  const usage = rollUsage(await readUsage(workspaceId, session), plan);
  if (usage.usagePeriod !== period) return { refunded: 0, commit: nothing };
  const refunded = Math.min(roundMinutes(minutes), usage.minutesDubbed);
  return {
    refunded,
    commit: () => writeUsage(workspaceId, { ...ledgerOf(usage), minutesDubbed: Math.max(0, roundMinutes(usage.minutesDubbed - minutes)) }, session),
  };
}

/**
 * Holds minutes for a voice clip (a Studio voiceover or a line preview) before it is made, so clips started together cannot all slip
 * under the allowance; settleVoiceMinutes then swaps the hold for what the clip really took. Returns the usage period to settle in.
 */
export async function reserveVoiceMinutes(workspaceId: string, minutes: number): Promise<string> {
  const period = await withTransaction(async (session) => {
    const reservation = await prepareReservation(session, workspaceId, minutes, VOICE_WORDING);
    await reservation.commit();
    return reservation.period;
  });
  afterCharge(workspaceId);
  return period;
}

// Seconds that make up one tenth of a minute, the step the ledger counts in.
const SECONDS_PER_TENTH = 6;

/**
 * Gives back a clip's hold and charges the seconds it actually voiced (0 for a clip that failed or came from the cache). The ledger
 * counts tenths of a minute, so whole 6-second steps are charged and the rest is carried to the next clip: a 4-second preview costs
 * 4 seconds over time, not a rounded-up 6 (or a rounded-away 0).
 */
export async function settleVoiceMinutes(workspaceId: string, reservedMinutes: number, voicedSeconds: number, period: string): Promise<void> {
  const plan = await planForWorkspace(workspaceId);
  await withTransaction(async (session) => {
    const usage = rollUsage(await readUsage(workspaceId, session), plan);
    // The period rolled over while the clip was being made: the new one starts from zero and holds nothing of it.
    if (usage.usagePeriod !== period) return;
    const carried = (usage.voiceSecondsCarry ?? 0) + Math.max(0, voicedSeconds);
    const tenths = Math.floor(carried / SECONDS_PER_TENTH + 1e-9);
    await writeUsage(
      workspaceId,
      {
        ...ledgerOf(usage),
        minutesDubbed: Math.max(0, roundMinutes(usage.minutesDubbed - reservedMinutes + tenths / 10)),
        voiceSecondsCarry: Math.round((carried - tenths * SECONDS_PER_TENTH) * 1000) / 1000,
      },
      session
    );
  });
}

/**
 * Analysis and translation are model calls that only pay off in a dub, so they need the allowance left to dub the video at least once
 * (one language, no paid extras). Refused like that dub would be; nothing is charged.
 */
export async function assertMinutesToDub(workspaceId: string, videoSeconds: number): Promise<void> {
  const [stored, plan] = await Promise.all([readUsage(workspaceId), planForWorkspace(workspaceId)]);
  const usage = rollUsage(stored, plan);
  // Rounded up to the tenth, so a refusal never reads "needs 5 min but 5 are left" for a video a few seconds over.
  assertCovered(usage, plan, Math.max(0.1, Math.ceil(((videoSeconds || 0) / 60) * 10 - 1e-9) / 10), VIDEO_WORDING);
}

export interface MinuteStatus {
  used: number;
  limit: number;
  period: string;
  renewsMonthly: boolean;
  planName: string;
  resetsAt?: string;
}

// The minutes ledger as the plan sees it, for usage emails: no storage measuring, one read.
export async function getMinuteStatus(workspaceId: string): Promise<MinuteStatus> {
  const [stored, plan] = await Promise.all([readUsage(workspaceId), planForWorkspace(workspaceId)]);
  const usage = rollUsage(stored, plan);
  return {
    used: usage.minutesDubbed,
    limit: usage.minutesLimit,
    period: usage.usagePeriod!,
    renewsMonthly: plan.renewsMonthly,
    planName: plan.name,
    ...(plan.renewsMonthly ? { resetsAt: nextResetIso() } : {}),
  };
}

// After minutes are charged: the usage emails check, in the background (loaded on use, as notifications.ts reads this module).
function afterCharge(workspaceId: string): void {
  void import('./notifications').then((m) => m.scheduleUsageCheck(workspaceId));
}

export function currentUsagePeriod(): string {
  return monthKey();
}

// Lifetime counters for a finished language; minutes are already charged by reserveDubMinutes.
export async function recordCompletedDub(
  workspaceId: string,
  opts: { wordsAdded: number; targetLanguageCode: string; fileSizeMb: number }
): Promise<void> {
  const plan = await planForWorkspace(workspaceId);
  await withTransaction(async (session) => {
    const current = rollUsage(await readUsage(workspaceId, session), plan);
    await writeUsage(
      workspaceId,
      {
        ...ledgerOf(current),
        totalProjects: current.totalProjects + 1,
        wordsTranslated: current.wordsTranslated + opts.wordsAdded,
        languagesUsed: current.languagesUsed + 1,
      },
      session
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

// Settings are read by every dub, analysis, preview and page load but change only through setSettings on this one process, so a short cache is exact.
const SETTINGS_CACHE_MS = 60_000;
const settingsCache = new Map<string, { settings: UserSettings; at: number }>();
// Profiles change only through setUserProfile on this one process, which clears the entry; the cache saves a read on every page load.
const PROFILE_CACHE_MS = 5 * 60_000;
const profileCache = new Map<string, { profile: UserProfile | null; at: number }>();

// Test seam: forgets cached settings and profiles when the database is wiped.
export function clearUserCaches(): void {
  settingsCache.clear();
  profileCache.clear();
}

export async function getSettings(uid: string): Promise<UserSettings> {
  const hit = settingsCache.get(uid);
  if (hit && Date.now() - hit.at < SETTINGS_CACHE_MS) return hit.settings;
  const stored = await settingsCol().findOne({ _id: uid }, { projection: { _id: 0 } });
  const settings = toUserSettings((stored ?? undefined) as Parameters<typeof toUserSettings>[0]);
  settingsCache.set(uid, { settings, at: Date.now() });
  return settings;
}

// A merge write: only the fields sent change, including single preferences.
export async function setSettings(
  uid: string,
  settings: Partial<ProviderSettings> & { preferences?: Partial<UserPreferences> }
): Promise<UserSettings> {
  const update = mergeUpdate(settings as Record<string, unknown>);
  if (update.$set || update.$unset) await settingsCol().updateOne({ _id: uid }, update, { upsert: true });
  const stored = await settingsCol().findOne({ _id: uid }, { projection: { _id: 0 } });
  const saved = toUserSettings((stored ?? undefined) as Parameters<typeof toUserSettings>[0]);
  settingsCache.set(uid, { settings: saved, at: Date.now() });
  return saved;
}

export interface UserProfile {
  name: string;
  // Kept for the client's shape; Dubly accounts have no job title or company of their own.
  role: string;
  workspace: string;
  // A small data: URL the person chose in Settings.
  avatar: string | null;
}

/** The name and picture a person chose at sign-up or in Settings; null when they chose neither (or the account is gone). */
export async function getUserProfile(uid: string): Promise<UserProfile | null> {
  const hit = profileCache.get(uid);
  if (hit && Date.now() - hit.at < PROFILE_CACHE_MS) return hit.profile;
  const user = await getUser(uid);
  const name = user?.displayName?.trim() || '';
  // Nothing chosen yet reads as no profile, and the app falls back to the email.
  const profile = user && (name || user.avatar) ? { name, role: '', workspace: '', avatar: user.avatar || null } : null;
  profileCache.set(uid, { profile, at: Date.now() });
  return profile;
}

// Saves the name and/or picture (null clears it) the person chose in Settings, and returns the profile as it now reads.
export async function setUserProfile(uid: string, patch: { name?: string; avatar?: string | null }): Promise<UserProfile> {
  await updateUserProfile(uid, { displayName: patch.name, avatar: patch.avatar });
  profileCache.delete(uid);
  return (await getUserProfile(uid))!;
}
