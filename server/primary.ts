import cluster from 'node:cluster';
import { limits } from './lib/limits';
import { installStructuredConsole } from './lib/log';

installStructuredConsole();

/**
 * Supervises the server processes on this machine: starts them, replaces one that dies, and passes a shutdown on. It holds no state and
 * no database connection; everything shared between the processes lives in MongoDB, so any of them can take any request.
 */
const STABLE_AFTER_MS = 60_000;
const MAX_RESTART_DELAY_MS = 30_000;
// Workers get their own grace period (SHUTDOWN_GRACE_MS, see worker.ts) to settle jobs; this only stops a stuck one holding the machine.
const STOP_TIMEOUT_MS = (Number(process.env.SHUTDOWN_GRACE_MS) || 25_000) + 10_000;

// Windows otherwise leaves connections to whichever process accepts first, which piles traffic onto one of them.
cluster.schedulingPolicy = cluster.SCHED_RR;

let stopping = false;
let quickExits = 0;

function start(): void {
  const startedAt = Date.now();
  const worker = cluster.fork();
  worker.once('exit', (code, signal) => {
    if (stopping) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    // A crash loop (a bad deploy, the database down) backs off instead of spinning; a process that ran for a while restarts straight away.
    quickExits = Date.now() - startedAt >= STABLE_AFTER_MS ? 0 : quickExits + 1;
    const delay = Math.min(MAX_RESTART_DELAY_MS, 500 * 2 ** quickExits);
    console.error(`[primary] process ${worker.process.pid} stopped (${signal ?? code}); starting another in ${delay}ms`);
    setTimeout(start, delay);
  });
}

function stop(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.warn(`[primary] ${signal}: stopping ${limits.processCount} process(es)`);
  // A message rather than a signal: on Windows a signal ends the process on the spot, before it can settle its jobs.
  const workers = Object.values(cluster.workers ?? {});
  if (workers.length === 0) process.exit(0);
  for (const worker of workers) worker?.send({ type: 'shutdown' });
  setTimeout(() => process.exit(1), STOP_TIMEOUT_MS).unref();
}

process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));

console.log(`[primary] starting ${limits.processCount} server processes`);
for (let i = 0; i < limits.processCount; i++) start();
