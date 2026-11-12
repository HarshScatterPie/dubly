import { hostname } from 'node:os';
import { limits } from './limits';
import { col } from './mongo';

/**
 * Every server process, on every machine or container, keeps a heartbeat in `instances`, so each knows how many share the traffic
 * (limits.totalProcesses, which divides the in-memory flood ceilings) however they were started, and as a platform or the supervisor
 * adds and removes them. A process that dies stops beating and drops out of the count; its record expires by itself.
 */
const BEAT_EVERY_MS = 15_000;
const LIVE_FOR_MS = 45_000;

interface InstanceDoc {
  _id: string;
  host: string;
  pid: number;
  at: Date;
  expireAt: Date;
}

const instances = () => col<InstanceDoc>('instances');
const me = `${hostname()}:${process.pid}`;
let timer: NodeJS.Timeout | undefined;

/** Beats once now and counts the live processes; returns that count. */
export async function beat(now = new Date()): Promise<number> {
  await instances().updateOne(
    { _id: me },
    { $set: { host: hostname(), pid: process.pid, at: now, expireAt: new Date(now.getTime() + LIVE_FOR_MS * 2) } },
    { upsert: true }
  );
  const live = await instances().countDocuments({ at: { $gt: new Date(now.getTime() - LIVE_FOR_MS) } });
  limits.totalProcesses = Math.max(1, live);
  return limits.totalProcesses;
}

export function startInstanceHeartbeat(): void {
  if (timer) return;
  const run = () => void beat().catch((err) => console.error('[instances] heartbeat failed', err));
  run();
  timer = setInterval(run, BEAT_EVERY_MS);
  timer.unref();
}

// Leaves the count at once on a clean stop, rather than after its heartbeat lapses.
export async function stopInstanceHeartbeat(): Promise<void> {
  clearInterval(timer);
  timer = undefined;
  await instances()
    .deleteOne({ _id: me })
    .catch(() => undefined);
}
