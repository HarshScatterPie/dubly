import { HttpError } from './httpError';
import { limits } from './limits';
import { acquireSlot } from './machineSlots';
import { log } from './log';

// Transcriptions and caption renders share the machine's heavy-work slots (machineSlots.ts), whichever process takes the request, so a
// burst of them cannot starve the dubs rendering on the same machine, or run it short of memory.

// Runs fn once a heavy-work slot is free; onWait fires only if it has to queue, and past heavyWaitMs the request gets a 503.
export async function withHeavySlot<T>(fn: () => Promise<T>, onWait?: () => unknown): Promise<T> {
  const release = await acquireHeavySlot(onWait);
  try {
    return await fn();
  } finally {
    release();
  }
}

// The same slot as withHeavySlot, for handlers that manage their own try/finally; call the returned function exactly once.
export async function acquireHeavySlot(onWait?: () => unknown): Promise<() => void> {
  const release = await acquireSlot('heavy', {
    waitMs: limits.heavyWaitMs,
    onQueued: () => {
      log.info('heavy_slot_wait', {});
      void Promise.resolve()
        .then(() => onWait?.())
        .catch((err) => log.error('heavy_slot_wait_notice_failed', err));
    },
  });
  if (!release) throw new HttpError(503, 'SERVER_BUSY', 'Dubly is busy processing other videos right now. Please try again in a few minutes.');
  return release;
}
