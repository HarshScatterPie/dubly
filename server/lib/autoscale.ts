/**
 * When the supervisor (primary.ts) adds a server process or retires one. A pure function of what the processes report, so it is
 * tested without starting any.
 *
 * - **Up, one at a time:** the processes have been busy for a while (their event loops on average 60% occupied, or one of them
 *   answering 200 ms late), there is room under MAX_PROCESSES, memory for one more (MIN_FREE_MEMORY_MB plus PROCESS_MEMORY_MB), and
 *   the last change was a little while ago, so each new process gets the chance to take load before the next is started.
 * - **Down, one at a time:** all of them have been quiet for three minutes, or the machine is short of memory; never below
 *   MIN_PROCESSES, and only a process with no dub or transcription running, so nobody's work is cut short.
 */
export interface ProcessLoad {
  id: number;
  // Share of the last report's interval the event loop was busy (0 to 1).
  elu: number;
  // How late timers fired, 95th percentile, in ms: how long a request waits before it is even looked at.
  lagMs: number;
  // Dubs and transcriptions running in the process.
  busy: number;
}

export interface ScaleInput {
  now: number;
  count: number;
  min: number;
  max: number;
  freeMb: number;
  minFreeMb: number;
  processMb: number;
  loads: ProcessLoad[];
  lastChangeAt: number;
  // Since when the processes have been continuously busy, or quiet (null: they are not).
  busySince: number | null;
  quietSince: number | null;
}

export type ScaleDecision = { action: 'up' } | { action: 'down'; id: number } | { action: 'hold' };

export const SCALE = {
  busyElu: 0.6,
  busyLagMs: 200,
  quietElu: 0.15,
  quietLagMs: 50,
  busyForMs: 10_000,
  quietForMs: 180_000,
  upCooldownMs: 20_000,
  downCooldownMs: 60_000,
};

export function isBusy(loads: ProcessLoad[]): boolean {
  if (loads.length === 0) return false;
  const averageElu = loads.reduce((sum, l) => sum + l.elu, 0) / loads.length;
  return averageElu >= SCALE.busyElu || loads.some((l) => l.lagMs >= SCALE.busyLagMs);
}

export function isQuiet(loads: ProcessLoad[]): boolean {
  return loads.length > 0 && loads.every((l) => l.elu < SCALE.quietElu && l.lagMs < SCALE.quietLagMs);
}

export function decideScale(input: ScaleInput): ScaleDecision {
  const { now, count, min, max, freeMb, minFreeMb, processMb, loads, lastChangeAt, busySince, quietSince } = input;
  // The least loaded process with nothing running: the only kind that may be retired.
  const idle = loads.filter((l) => l.busy === 0).sort((a, b) => a.elu - b.elu)[0];
  const sinceChange = now - lastChangeAt;

  // Short of memory: one idle process's memory goes back to the machine, busy or not.
  if (freeMb < minFreeMb / 2 && count > min && idle && sinceChange >= SCALE.downCooldownMs) return { action: 'down', id: idle.id };
  if (busySince !== null && now - busySince >= SCALE.busyForMs && count < max && freeMb >= minFreeMb + processMb && sinceChange >= SCALE.upCooldownMs) {
    return { action: 'up' };
  }
  if (quietSince !== null && now - quietSince >= SCALE.quietForMs && count > min && idle && sinceChange >= SCALE.downCooldownMs) {
    return { action: 'down', id: idle.id };
  }
  return { action: 'hold' };
}
