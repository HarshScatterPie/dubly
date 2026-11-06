import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { rm } from 'node:fs/promises';
import type { ClientSession } from 'mongodb';
import { col, DELETE_FIELD, withTransaction } from './mongo';
import { prepareRefund, prepareReservation, type StoredProject } from './projectRepo';
import { tmpDir } from './paths';
import { applyPlan, loadProjectMeta, planProjectWrite, projectsCol, type ProjectDoc } from './projectStorage';
import type { PaidExtrasChoice } from '../../src/lib/planMath';

// A job is the persisted record of one dub or transcription: project ownership, heartbeat, cancellation and exactly-once minute settlement.
export type JobStatus = 'queued' | 'running' | 'completed' | 'partially_completed' | 'failed' | 'cancelled';
export type JobType = 'dub' | 'transcribe';

export interface DubJob {
  id: string;
  type: JobType;
  projectId: string;
  workspaceId: string;
  userId: string;
  status: JobStatus;
  stage: string;
  progress: number;
  languages: string[];
  completedLanguages: string[];
  failedLanguages: string[];
  minutesReserved: number;
  minutesRefunded: number;
  usagePeriod: string;
  attemptCount: number;
  idempotencyKey: string | null;
  // True once the outcome and the refund have been written; nothing touches a settled job again.
  settled: boolean;
  createdAt: string;
  startedAt: string;
  heartbeatAt: string;
  finishedAt: string | null;
  errorCode: string | null;
  // Internal detail for operators (never sent to clients); userMessage is what the UI may show.
  errorMessage: string | null;
  userMessage?: string | null;
  // Set by a cancel request or the job's own timeout; the run stops at its next progress write.
  cancelRequested?: 'user' | 'timeout' | null;
  // Outcome details the client needs after completion (e.g. a transcription's detected language).
  result?: Record<string, unknown> | null;
  // The paid extras this dub was charged for; the render uses exactly these, whatever the settings say later.
  extras?: PaidExtrasChoice;
  // Length of the source video (seconds) the charge was worked out from; a longer video swapped in before the run starts is refused.
  sourceSeconds?: number;
}

export const HEARTBEAT_INTERVAL_MS = 15_000;
// Six missed heartbeats: comfortably past any GC pause or slow database write, well short of a user giving up.
export const STALE_AFTER_MS = 90_000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

const jobsCol = () => col<DubJob & { _id: string; providerUsage?: Record<string, number> }>('jobs');
const idempotencyCol = () => col<{ _id: string; jobId: string; createdAt: string }>('jobIdempotency');

export const jobDirFor = (jobId: string) => path.join(tmpDir, 'jobs', jobId);

export class JobConflictError extends Error {
  constructor(
    public jobId: string,
    activeType: JobType = 'dub'
  ) {
    super(
      activeType === 'transcribe'
        ? 'This video is still being analyzed. Wait for that to finish before starting another run.'
        : 'This project is already being dubbed. Wait for that run to finish before starting another.'
    );
  }
}

// Thrown out of a run's progress write once cancellation was requested; the runner settles the job as cancelled.
export class JobCancelledError extends Error {
  constructor(
    public jobId: string,
    public reason: 'user' | 'timeout'
  ) {
    super(reason === 'timeout' ? 'The run took too long and was stopped.' : 'The run was cancelled.');
  }
}

// Thrown by a guarded write when this job no longer owns the project (it was settled as interrupted, or the project was deleted).
export class JobSupersededError extends Error {
  constructor(public jobId: string) {
    super('This dubbing run was stopped and replaced.');
  }
}

class StaleActiveJob extends Error {
  constructor(public jobId: string) {
    super('stale job');
  }
}

export async function getJob(jobId: string): Promise<DubJob | null> {
  return (await jobsCol().findOne({ _id: jobId }, { projection: { _id: 0 } })) as DubJob | null;
}

export function isStale(job: Pick<DubJob, 'heartbeatAt'>, now = Date.now()): boolean {
  return now - new Date(job.heartbeatAt).getTime() > STALE_AFTER_MS;
}

export interface StartDubJobInput {
  workspaceId: string;
  projectId: string;
  userId: string;
  languages: string[];
  minutes: number;
  idempotencyKey?: string;
  extras?: PaidExtrasChoice;
  sourceSeconds?: number;
}

// Creates the job, takes the project and reserves minutes in one transaction; a repeated Idempotency-Key returns the earlier job.
export async function startDubJob(input: StartDubJobInput): Promise<{ job: DubJob; replayed: boolean }> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await startDubJobOnce(input);
    } catch (err) {
      // A run whose process died still holds the project; settle it as interrupted (refunding it) and try once more.
      if (err instanceof StaleActiveJob && attempt === 0) {
        await settleInterruptedJob(err.jobId);
        continue;
      }
      throw err;
    }
  }
}

// The project's current holder, if it still holds it: a conflict while it runs, a StaleActiveJob once its process is gone.
async function assertProjectFree(project: ProjectDoc, session: ClientSession): Promise<void> {
  if (!project.activeJobId) return;
  const activeJob = (await jobsCol().findOne({ _id: project.activeJobId }, { session, projection: { _id: 0 } })) as DubJob | null;
  if (activeJob && !activeJob.settled) {
    if (isStale(activeJob)) throw new StaleActiveJob(activeJob.id);
    throw new JobConflictError(activeJob.id, activeJob.type);
  }
}

async function startDubJobOnce(input: StartDubJobInput): Promise<{ job: DubJob; replayed: boolean }> {
  const key = input.idempotencyKey?.trim() || null;
  const idemId = key ? createHash('sha256').update(`${input.workspaceId}|${input.projectId}|${key}`).digest('hex') : null;

  return withTransaction(async (session) => {
    if (idemId) {
      const idem = await idempotencyCol().findOne({ _id: idemId }, { session });
      if (idem && Date.now() - new Date(idem.createdAt).getTime() < IDEMPOTENCY_TTL_MS) {
        const earlier = await getJobIn(idem.jobId, session);
        if (earlier) return { job: earlier, replayed: true };
      }
    }

    const project = await loadProjectMeta(input.workspaceId, input.projectId, session);
    if (!project) throw new Error('Project not found');
    await assertProjectFree(project, session);

    const reservation = await prepareReservation(session, input.workspaceId, input.minutes);
    const now = new Date().toISOString();
    const job: DubJob = {
      id: `job-${randomUUID()}`,
      type: 'dub',
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      // Admission (server/lib/dubQueue.ts) moves it to running once a slot is free.
      status: 'queued',
      stage: 'queued',
      progress: 5,
      languages: input.languages,
      completedLanguages: [],
      failedLanguages: [],
      minutesReserved: input.minutes,
      minutesRefunded: 0,
      usagePeriod: reservation.period,
      attemptCount: (project.dubAttempts || 0) + 1,
      idempotencyKey: key,
      settled: false,
      createdAt: now,
      startedAt: now,
      heartbeatAt: now,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      ...(input.extras ? { extras: input.extras } : {}),
      ...(input.sourceSeconds ? { sourceSeconds: input.sourceSeconds } : {}),
    };
    await reservation.commit();
    await jobsCol().insertOne({ _id: job.id, ...job }, { session });
    await projectsCol().updateOne(
      { _id: input.projectId, workspaceId: input.workspaceId },
      {
        $set: {
          activeJobId: job.id,
          dubAttempts: job.attemptCount,
          status: 'processing',
          progressPercent: 5,
          currentProcessingMessage: 'Preparing dubbing pipeline...',
          updatedAt: now,
        },
      },
      { session }
    );
    if (idemId) await idempotencyCol().replaceOne({ _id: idemId }, { jobId: job.id, createdAt: now }, { upsert: true, session });
    return { job, replayed: false };
  });
}

async function getJobIn(jobId: string, session: ClientSession): Promise<DubJob | null> {
  return (await jobsCol().findOne({ _id: jobId }, { session, projection: { _id: 0 } })) as DubJob | null;
}

// Starts a transcription: takes the project and records the job in one transaction, settling a stale holder first; nothing is charged.
export async function startTranscribeJob(input: { workspaceId: string; projectId: string; userId: string }): Promise<DubJob> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await startTranscribeJobOnce(input);
    } catch (err) {
      if (err instanceof StaleActiveJob && attempt === 0) {
        await settleInterruptedJob(err.jobId);
        continue;
      }
      throw err;
    }
  }
}

async function startTranscribeJobOnce(input: { workspaceId: string; projectId: string; userId: string }): Promise<DubJob> {
  return withTransaction(async (session) => {
    const project = await loadProjectMeta(input.workspaceId, input.projectId, session);
    if (!project) throw new Error('Project not found');
    await assertProjectFree(project, session);
    const now = new Date().toISOString();
    const job: DubJob = {
      id: `job-${randomUUID()}`,
      type: 'transcribe',
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      userId: input.userId,
      status: 'running',
      stage: 'starting',
      progress: 2,
      languages: [],
      completedLanguages: [],
      failedLanguages: [],
      minutesReserved: 0,
      minutesRefunded: 0,
      usagePeriod: '',
      attemptCount: 1,
      idempotencyKey: null,
      settled: false,
      createdAt: now,
      startedAt: now,
      heartbeatAt: now,
      finishedAt: null,
      errorCode: null,
      errorMessage: null,
      userMessage: null,
      cancelRequested: null,
      result: null,
    };
    await jobsCol().insertOne({ _id: job.id, ...job }, { session });
    await projectsCol().updateOne(
      { _id: input.projectId, workspaceId: input.workspaceId },
      { $set: { activeJobId: job.id, progressPercent: 2, currentProcessingMessage: 'Starting analysis', updatedAt: now } },
      { session }
    );
    return job;
  });
}

// Asks a run to stop; it notices at its next progress write. False if the job is already finished. An earlier reason is kept.
export async function requestCancel(jobId: string, reason: 'user' | 'timeout' = 'user'): Promise<boolean> {
  const updated = await jobsCol().findOneAndUpdate({ _id: jobId, settled: false }, [{ $set: { cancelRequested: { $ifNull: ['$cancelRequested', reason] } } }]);
  return updated !== null;
}

// The view of a job a client may see: no internal error text.
export function toClientJob(job: DubJob) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    settled: job.settled,
    errorCode: job.errorCode,
    message: job.userMessage ?? null,
    result: job.result ?? null,
    languages: job.languages,
    completedLanguages: job.completedLanguages,
    failedLanguages: job.failedLanguages,
    minutesReserved: job.minutesReserved,
    minutesRefunded: job.minutesRefunded,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
  };
}

// Marks an admitted job running; false if it was settled, cancelled or lost the project while waiting, so it must not run.
export async function markJobStarted(job: Pick<DubJob, 'id' | 'workspaceId' | 'projectId'>): Promise<boolean> {
  return withTransaction(async (session) => {
    const stored = await getJobIn(job.id, session);
    const project = await loadProjectMeta(job.workspaceId, job.projectId, session);
    if (!stored || stored.settled || !project || project.activeJobId !== job.id) return false;
    // Cancelled while it waited: it never starts (the cancel request settles it).
    if (stored.cancelRequested) return false;
    const now = new Date().toISOString();
    await jobsCol().updateOne({ _id: job.id }, { $set: { status: 'running', stage: 'starting', startedAt: now, heartbeatAt: now } }, { session });
    await projectsCol().updateOne(
      { _id: job.projectId, workspaceId: job.workspaceId },
      { $set: { currentProcessingMessage: 'Preparing dubbing pipeline...', updatedAt: now } },
      { session }
    );
    return true;
  });
}

// Writes to the project for a job only while it owns the project, updating its progress and heartbeat in the same transaction.
export async function writeProjectForJob(
  job: Pick<DubJob, 'id' | 'workspaceId' | 'projectId'>,
  patch: Partial<StoredProject>,
  jobPatch: Partial<Pick<DubJob, 'stage' | 'progress' | 'completedLanguages' | 'failedLanguages'>> = {}
): Promise<void> {
  await withTransaction(async (session) => {
    const project = await loadProjectMeta(job.workspaceId, job.projectId, session);
    const stored = await jobsCol().findOne({ _id: job.id }, { session, projection: { cancelRequested: 1 } });
    if (!project || project.activeJobId !== job.id) throw new JobSupersededError(job.id);
    // Every run reports progress between steps, which makes this the natural place to notice a cancel request.
    const cancel = stored?.cancelRequested;
    if (cancel) throw new JobCancelledError(job.id, cancel);
    const now = new Date().toISOString();
    await applyPlan(job.workspaceId, job.projectId, planProjectWrite(job.workspaceId, job.projectId, project, { ...patch, updatedAt: now }), session);
    await jobsCol().updateOne({ _id: job.id }, { $set: { ...jobPatch, heartbeatAt: now } }, { session });
  });
}

// Checked right before overwriting shared output paths in storage, so a run that lost ownership stops before it uploads.
export async function assertStillActive(job: Pick<DubJob, 'id' | 'workspaceId' | 'projectId'>): Promise<void> {
  const project = await projectsCol().findOne({ _id: job.projectId, workspaceId: job.workspaceId }, { projection: { activeJobId: 1 } });
  if (!project || project.activeJobId !== job.id) throw new JobSupersededError(job.id);
}

export interface JobOutcome {
  status: Exclude<JobStatus, 'queued' | 'running'>;
  refundMinutes: number;
  errorCode?: string;
  errorMessage?: string;
  userMessage?: string;
  result?: Record<string, unknown>;
  completedLanguages?: string[];
  failedLanguages?: string[];
  // Applied to the project only if this job still owns it.
  projectPatch?: Partial<StoredProject>;
}

// Records a job's outcome, refunds unused minutes and releases the project in one transaction, exactly once.
export async function settleJob(jobId: string, outcome: JobOutcome): Promise<boolean> {
  return withTransaction(async (session) => {
    const job = await getJobIn(jobId, session);
    if (!job || job.settled) return false;
    const project = await loadProjectMeta(job.workspaceId, job.projectId, session);
    const refund = await prepareRefund(session, job.workspaceId, Math.min(Math.max(0, outcome.refundMinutes), job.minutesReserved), job.usagePeriod);

    const now = new Date().toISOString();
    await refund.commit();
    await jobsCol().updateOne(
      { _id: jobId },
      {
        $set: {
          status: outcome.status,
          settled: true,
          finishedAt: now,
          heartbeatAt: now,
          stage: 'finished',
          progress: outcome.status === 'completed' || outcome.status === 'partially_completed' ? 100 : job.progress,
          minutesRefunded: refund.refunded,
          errorCode: outcome.errorCode ?? null,
          errorMessage: outcome.errorMessage ?? null,
          userMessage: outcome.userMessage ?? null,
          result: outcome.result ?? null,
          completedLanguages: outcome.completedLanguages ?? job.completedLanguages,
          failedLanguages: outcome.failedLanguages ?? job.failedLanguages,
        },
      },
      { session }
    );
    if (project && project.activeJobId === jobId) {
      const plan = planProjectWrite(job.workspaceId, job.projectId, project, { ...(outcome.projectPatch || {}), updatedAt: now });
      await applyPlan(job.workspaceId, job.projectId, { ...plan, project: { ...plan.project, activeJobId: DELETE_FIELD } }, session);
    }
    return true;
  });
}

export const INTERRUPTED_MESSAGE = 'Dubbing was interrupted by a server restart. Your minutes were not charged — start the dub again.';
export const ANALYSIS_INTERRUPTED_MESSAGE = 'Analysis was interrupted by a server restart. Please start it again.';

// Settles a job whose process is gone: failed, every reserved minute refunded, scratch files removed.
export async function settleInterruptedJob(jobId: string): Promise<boolean> {
  const job = await getJob(jobId);
  if (!job) return false;
  const isDub = job.type !== 'transcribe';
  const message = isDub ? INTERRUPTED_MESSAGE : ANALYSIS_INTERRUPTED_MESSAGE;
  const settled = await settleJob(jobId, {
    status: 'failed',
    refundMinutes: job.minutesReserved,
    errorCode: 'INTERRUPTED',
    errorMessage: message,
    userMessage: message,
    // A transcription never changed the project's status, so only its progress display is reset.
    projectPatch: isDub ? { status: 'failed', currentProcessingMessage: message } : { progressPercent: 0, currentProcessingMessage: '' },
  });
  await rm(jobDirFor(jobId), { recursive: true, force: true }).catch(() => undefined);
  return settled;
}

// Settles jobs whose heartbeat stopped as interrupted, or re-queues ones that never started when requeue is given; exclude lists live local jobs.
export async function reconcileStaleJobs(
  exclude: ReadonlySet<string> = new Set(),
  now = Date.now(),
  requeue?: (job: DubJob) => void
): Promise<string[]> {
  const unsettled = (await jobsCol().find({ settled: false }, { projection: { _id: 0 } }).toArray()) as DubJob[];
  const stale = unsettled.filter((job) => !exclude.has(job.id) && isStale(job, now)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const recovered: string[] = [];
  for (const job of stale) {
    if (requeue && job.status === 'queued') {
      const claimed = await claimQueuedJob(job.id, now);
      if (claimed) requeue(claimed);
      continue;
    }
    if (await settleInterruptedJob(job.id)) recovered.push(job.id);
  }
  return recovered;
}

// Takes over a stale queued job for this process (fresh heartbeat), unless someone else already did: one conditional write.
async function claimQueuedJob(jobId: string, now: number): Promise<DubJob | null> {
  const staleBefore = new Date(now - STALE_AFTER_MS).toISOString();
  return (await jobsCol().findOneAndUpdate(
    { _id: jobId, settled: false, status: 'queued', heartbeatAt: { $lt: staleBefore } },
    { $set: { heartbeatAt: new Date().toISOString() } },
    { returnDocument: 'after', projection: { _id: 0 } }
  )) as DubJob | null;
}

// Provider usage of a run, kept on the job for cost reporting; best-effort, never fails the job.
export async function recordJobUsage(jobId: string, usage: Record<string, number>): Promise<void> {
  await jobsCol()
    .updateOne({ _id: jobId }, { $set: { providerUsage: usage } })
    .catch((err) => console.error(`[jobs] could not record usage for ${jobId}`, err));
}

// Keeps a running job's heartbeat fresh; the returned function stops it.
export function startHeartbeat(jobId: string, intervalMs = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    jobsCol()
      .updateOne({ _id: jobId }, { $set: { heartbeatAt: new Date().toISOString() } })
      .catch((err) => console.error(`[jobs] heartbeat failed for ${jobId}`, err));
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

// Jobs running in this process, so shutdown can settle them and reconciliation can leave them alone.
const runningHere = new Set<string>();

export function markRunningHere(jobId: string): () => void {
  runningHere.add(jobId);
  return () => runningHere.delete(jobId);
}

export function jobsRunningHere(): ReadonlySet<string> {
  return runningHere;
}
