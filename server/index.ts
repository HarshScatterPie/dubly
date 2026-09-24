import { env } from './lib/env';
import { installStructuredConsole } from './lib/log';

// Before anything logs: every console line becomes a structured, redacted record (JSON in production).
installStructuredConsole();
import { createApp } from './app';
import { jobDirFor, jobsRunningHere, reconcileStaleJobs, settleInterruptedJob, STALE_AFTER_MS } from './lib/jobs';
import { backgroundWorkCount, startDraining, waitForBackgroundWork } from './lib/lifecycle';
import { sweepTmp } from './lib/tmpSweeper';
import { sweepExpiredRecords } from './lib/recordSweeper';
import { freezeQueue } from './lib/dubQueue';
import { enqueueDubJob } from './routes/dub';

// How long a deploy's SIGTERM waits for running dubs before settling them as interrupted (refunded); keep it under the host's kill timeout.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 25_000;
const RECONCILE_EVERY_MS = 60_000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

const app = createApp();
const server = app.listen(env.port, () => {
  console.log(`Dubly API listening on http://localhost:${env.port}`);
});

async function reconcile(reason: string): Promise<void> {
  try {
    const requeued: string[] = [];
    // Jobs that were still waiting when their process went away never started, so they go back in the queue rather than failing.
    const recovered = await reconcileStaleJobs(jobsRunningHere(), Date.now(), (job) => {
      requeued.push(job.id);
      enqueueDubJob(job);
    });
    if (recovered.length) console.warn(`[jobs] ${reason}: settled ${recovered.length} interrupted job(s): ${recovered.join(', ')}`);
    if (requeued.length) console.warn(`[jobs] ${reason}: re-queued ${requeued.length} waiting job(s): ${requeued.join(', ')}`);
  } catch (err) {
    console.error('[jobs] reconciliation failed', err);
  }
}

async function sweep(): Promise<void> {
  try {
    const removed = await sweepTmp({ keep: new Set([...jobsRunningHere()].map(jobDirFor)) });
    if (removed.length) console.log(`[tmp] removed ${removed.length} stale scratch entr${removed.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.error('[tmp] sweep failed', err);
  }
  try {
    await sweepExpiredRecords();
  } catch (err) {
    console.error('[retention] expired-record sweep failed', err);
  }
}

// Jobs orphaned by the previous process are settled once their heartbeat is stale; the periodic pass catches the ones that are not stale yet at boot.
void reconcile('startup');
void sweep();
const reconcileTimer = setInterval(() => void reconcile('periodic'), RECONCILE_EVERY_MS);
const sweepTimer = setInterval(() => void sweep(), SWEEP_EVERY_MS);
reconcileTimer.unref();
sweepTimer.unref();
console.log(`[jobs] stale-job reconciliation every ${RECONCILE_EVERY_MS / 1000}s (stale after ${STALE_AFTER_MS / 1000}s)`);

let shuttingDown = false;

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`[server] ${signal}: draining (${backgroundWorkCount()} job(s) running, grace ${SHUTDOWN_GRACE_MS}ms)`);
  startDraining();
  // Waiting dubs are left untouched for the next process to pick up; only the ones already rendering are waited for.
  const released = freezeQueue();
  if (released) console.warn(`[server] released ${released} queued job(s) for the next process`);
  clearInterval(reconcileTimer);
  clearInterval(sweepTimer);
  server.close();

  const finished = await waitForBackgroundWork(SHUTDOWN_GRACE_MS);
  if (!finished) {
    // Settled now rather than left for the next process to notice: users see a clear failure and get their minutes back immediately.
    const leftover = [...jobsRunningHere()];
    await Promise.allSettled(leftover.map((jobId) => settleInterruptedJob(jobId)));
    console.warn(`[server] settled ${leftover.length} unfinished job(s) as interrupted`);
  }
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));

// Logged, not fatal: every route is wrapped, so a stray rejection here is a bug to fix, not a reason to kill running dubs.
process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandledRejection', reason);
});

// State after an uncaught exception is unknown, so the process exits, but only after settling its jobs so nobody is left charged and stuck.
process.on('uncaughtException', (err) => {
  console.error('[server] uncaughtException', err);
  startDraining();
  freezeQueue();
  const hardExit = setTimeout(() => process.exit(1), 10_000);
  hardExit.unref();
  void Promise.allSettled([...jobsRunningHere()].map((jobId) => settleInterruptedJob(jobId))).finally(() => process.exit(1));
});
