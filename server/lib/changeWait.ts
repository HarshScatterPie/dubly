import { createHash } from 'node:crypto';

/**
 * Long polling for progress. A client sends the revision it last saw and the answer waits until there is something new, so following a
 * job costs a few requests a minute instead of one or two a second. That matters most behind a front door that counts requests.
 * One timer serves every waiting request in the process, and the database is read, not the requests multiplied.
 */
// New progress is held back this long, so a job reporting every second is still one answer per hold. A finished job answers at once.
export const MIN_HOLD_MS = 5_000;
// Well inside what proxies and tunnels allow an idle request, and it proves to the client the server is still there.
export const MAX_HOLD_MS = 25_000;
const TICK_MS = 1_500;

export const revisionOf = (...parts: unknown[]): string => createHash('sha1').update(JSON.stringify(parts)).digest('hex').slice(0, 12);

interface Watch<T> {
  // Null ends the wait: what was being watched has gone.
  read: () => Promise<T | null>;
  revision: (value: T) => string;
  isFinal: (value: T) => boolean;
  since: string;
}

interface Waiter extends Watch<unknown> {
  startedAt: number;
  answer: (value: unknown) => void;
  fail: (err: unknown) => void;
}

const waiters = new Set<Waiter>();
let timer: NodeJS.Timeout | null = null;

function schedule(): void {
  if (timer || waiters.size === 0) return;
  timer = setTimeout(() => void tick(), TICK_MS);
  timer.unref();
}

async function tick(): Promise<void> {
  const now = Date.now();
  await Promise.all(
    [...waiters].map(async (waiter) => {
      try {
        const value = await waiter.read();
        if (!waiters.has(waiter)) return;
        const held = now - waiter.startedAt;
        const changed = value !== null && waiter.revision(value) !== waiter.since;
        if (value === null || waiter.isFinal(value) || held >= MAX_HOLD_MS || (changed && held >= MIN_HOLD_MS)) {
          waiters.delete(waiter);
          waiter.answer(value);
        }
      } catch (err) {
        if (waiters.delete(waiter)) waiter.fail(err);
      }
    })
  );
  timer = null;
  schedule();
}

/** The current value once it differs from `since`, is final, or the hold runs out. Without `since` it answers straight away. `onClosed` lets the caller stop waiting for a client that left. */
export async function waitForChange<T>(watch: Watch<T>, onClosed: (stop: () => void) => void): Promise<T | null> {
  const first = await watch.read();
  if (!watch.since || first === null || watch.isFinal(first)) return first;
  return new Promise<T | null>((resolve, reject) => {
    const waiter: Waiter = { ...(watch as Watch<unknown>), startedAt: Date.now(), answer: (value) => resolve(value as T | null), fail: reject };
    waiters.add(waiter);
    onClosed(() => {
      if (waiters.delete(waiter)) resolve(first);
    });
    schedule();
  });
}

/** Answers everyone waiting now, so a shutdown is not held up by idle requests. */
export function releaseChangeWaits(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  for (const waiter of waiters) {
    waiters.delete(waiter);
    void waiter.read().then(waiter.answer, waiter.fail);
  }
}
