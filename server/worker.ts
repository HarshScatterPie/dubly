import { env } from './lib/env';
import { installStructuredConsole } from './lib/log';

// Before anything logs: every console line becomes a structured, redacted record (JSON in production).
installStructuredConsole();
import { createApp } from './app';
import { closeMongo, connectMongo } from './lib/mongo';
import { ensureMediaIndexes } from './lib/mediaStore';
import { jobDirFor, jobsRunningHere, reconcileStaleJobs, settleInterruptedJob, STALE_AFTER_MS, unsettledJobIds } from './lib/jobs';
import { backgroundWorkCount, startDraining, waitForBackgroundWork } from './lib/lifecycle';
import { sweepTmp } from './lib/tmpSweeper';
import { sweepExpiredRecords } from './lib/recordSweeper';
import { freezeQueue, startDubDispatcher } from './lib/dubQueue';
import { startCacheBus, stopCacheBus } from './lib/cacheBus';
import { releaseChangeWaits } from './lib/changeWait';
import { onceEvery } from './lib/leases';
import { limits } from './lib/limits';
import { startInstanceHeartbeat, stopInstanceHeartbeat } from './lib/instances';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
// Registers the dub runner with the queue.
import './routes/dub';

// How long a deploy's SIGTERM waits for running dubs before settling them as interrupted (refunded); keep it under the host's kill timeout.
const SHUTDOWN_GRACE_MS = Number(process.env.SHUTDOWN_GRACE_MS) || 25_000;
const RECONCILE_EVERY_MS = 60_000;
const SWEEP_EVERY_MS = 60 * 60 * 1000;

// Nothing is served until MongoDB answers as a replica set and its indexes exist; a misconfigured database stops the start with the fix in the log.
try {
  await connectMongo();
  await ensureMediaIndexes();
  console.log('[mongo] connected');
} catch (err) {
  console.error('[mongo] cannot start without the database', err);
  process.exit(1);
}

// With more than one process, a cache cleared here has to be cleared in the others too. In production there may always be others
// (the supervisor scales, a platform may run several containers), so the bus runs there whatever the count is now.
if (limits.maxProcesses > 1 || limits.totalProcesses > 1 || process.env.NODE_ENV === 'production') startCacheBus();
// Counts the live processes on every machine, which divides the in-memory flood ceilings between them.
startInstanceHeartbeat();

const app = createApp();
const onListening = () => console.log(`Dubly API listening on http://${env.host || 'localhost'}:${env.port}`);
const server = env.host ? app.listen(env.port, env.host, onListening) : app.listen(env.port, onListening);

// Under a supervisor: how busy this process is, every 5 s, for its scaling decisions (autoscale.ts).
const LOAD_EVERY_MS = 5_000;
const LAG_RESOLUTION_MS = 20;
if (process.send) {
  const lag = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS });
  lag.enable();
  let last = performance.eventLoopUtilization();
  const report = setInterval(() => {
    const now = performance.eventLoopUtilization();
    const elu = performance.eventLoopUtilization(now, last).utilization;
    last = now;
    // The histogram counts its own sampling interval as delay; only what is beyond it is lateness.
    const lagMs = Math.max(0, lag.percentile(95) / 1e6 - LAG_RESOLUTION_MS);
    lag.reset();
    try {
      process.send?.({ type: 'load', elu, lagMs, busy: backgroundWorkCount() });
    } catch {
      // The supervisor is going away; the next report, if any, will do.
    }
  }, LOAD_EVERY_MS);
  report.unref();
}

async function reconcile(reason: string): Promise<void> {
  try {
    // One process per round does this, whichever gets there first.
    await onceEvery('reconcile-jobs', RECONCILE_EVERY_MS - 5_000, async () => {
      const recovered = await reconcileStaleJobs(jobsRunningHere());
      if (recovered.length) console.warn(`[jobs] ${reason}: settled ${recovered.length} interrupted job(s): ${recovered.join(', ')}`);
    });
  } catch (err) {
    console.error('[jobs] reconciliation failed', err);
  }
}

async function sweep(): Promise<void> {
  try {
    // Every process and machine sweeps its own disk, and a folder can belong to a job running in a sibling process, so what stays comes from the database.
    const removed = await sweepTmp({ keep: new Set((await unsettledJobIds()).map(jobDirFor)) });
    if (removed.length) console.log(`[tmp] removed ${removed.length} stale scratch entr${removed.length === 1 ? 'y' : 'ies'}`);
  } catch (err) {
    console.error('[tmp] sweep failed', err);
  }
  try {
    await onceEvery('sweep-expired-records', SWEEP_EVERY_MS - 60_000, async () => void (await sweepExpiredRecords()));
  } catch (err) {
    console.error('[retention] expired-record sweep failed', err);
  }
}

// Jobs orphaned by the previous process are settled once their heartbeat is stale; the periodic pass catches the ones that are not stale yet at boot.
void reconcile('startup');
void sweep();
// Takes dubs left waiting by the last process, and from now on any that fit here.
startDubDispatcher();
const reconcileTimer = setInterval(() => void reconcile('periodic'), RECONCILE_EVERY_MS);
const sweepTimer = setInterval(() => void sweep(), SWEEP_EVERY_MS);
reconcileTimer.unref();
sweepTimer.unref();
console.log(`[jobs] stale-job reconciliation every ${RECONCILE_EVERY_MS / 1000}s (stale after ${STALE_AFTER_MS / 1000}s)`);

let shuttingDown = false;
let retiring = false;

/**
 * The supervisor no longer needs this process (it was idle and the machine quiet, or memory short). Unlike a shutdown, nothing is cut
 * short: it stops taking connections and dubs, lets what it was doing finish however long that takes, and exits. Requests keep being
 * served by the other processes, with no "restarting" answers.
 */
async function retire(): Promise<void> {
  if (retiring || shuttingDown) return;
  retiring = true;
  console.log(`[server] retiring: finishing ${backgroundWorkCount()} job(s) first`);
  freezeQueue();
  releaseChangeWaits();
  clearInterval(reconcileTimer);
  clearInterval(sweepTimer);
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeIdleConnections();
  // As long as the longest dub could take; the supervisor stops a process still retiring after that (primary.ts, RETIRE_TIMEOUT_MS).
  await waitForBackgroundWork(3 * 60 * 60 * 1000);
  // Requests already being answered finish too, up to a minute; a connection held open idle does not keep the process.
  await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 60_000).unref())]);
  if (shuttingDown) return;
  await stopInstanceHeartbeat();
  await stopCacheBus();
  await closeMongo().catch(() => undefined);
  process.exit(0);
}

async function shutdown(signal: string, exitCode: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.warn(`[server] ${signal}: draining (${backgroundWorkCount()} job(s) running, grace ${SHUTDOWN_GRACE_MS}ms)`);
  startDraining();
  // Waiting dubs stay in the database for another process; only the ones already rendering here are waited for.
  freezeQueue();
  // Requests waiting on progress would otherwise hold the server open; clients simply ask again, of another process.
  releaseChangeWaits();
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
  await stopInstanceHeartbeat();
  await stopCacheBus();
  await closeMongo().catch(() => undefined);
  process.exit(exitCode);
}

process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
process.on('SIGINT', () => void shutdown('SIGINT', 0));
// How the supervising process (primary.ts) asks; a signal would end this one on the spot on Windows.
process.on('message', (message: { type?: string }) => {
  if (message?.type === 'shutdown') void shutdown('shutdown request', 0);
  if (message?.type === 'retire') void retire();
});

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
