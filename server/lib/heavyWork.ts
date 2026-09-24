import { HttpError } from './httpError';
import { limits } from './limits';
import { Semaphore, SemaphoreTimeoutError } from './semaphore';
import { log } from './log';

// Transcriptions and caption renders share these slots, so a burst of them cannot starve the dubs rendering on the same machine.
export const heavyWork = new Semaphore(limits.maxHeavyRequests);

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
  if (heavyWork.inUse >= limits.maxHeavyRequests || heavyWork.waiting > 0) {
    log.info('heavy_slot_wait', { inUse: heavyWork.inUse, waiting: heavyWork.waiting + 1 });
    await onWait?.();
  }
  try {
    return await heavyWork.acquire(limits.heavyWaitMs);
  } catch (err) {
    if (err instanceof SemaphoreTimeoutError) {
      throw new HttpError(503, 'SERVER_BUSY', 'Dubly is busy processing other videos right now. Please try again in a few minutes.');
    }
    throw err;
  }
}
