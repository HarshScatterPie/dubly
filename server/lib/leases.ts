import { randomUUID } from 'node:crypto';
import { col, isDuplicateKeyError } from './mongo';

/**
 * Time-limited claims every process can see, for work that must be bounded across all of them: at most `cap` holders of a name at once.
 * A claim is only a promise until `until`, so a process that dies gives its place back by itself; there is nothing to clean up.
 */
interface LeaseDoc {
  _id: string;
  holders: { token: string; until: number }[];
  expireAt: Date;
}

const leases = () => col<LeaseDoc>('leases');
const KEEP_AFTER_LAST_HOLDER_MS = 60_000;

// Two first claims on a new name can race to create its document; the loser simply tries again against the one that won.
async function retryingCreateRace<T>(write: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (!isDuplicateKeyError(err) || attempt >= 3) throw err;
    }
  }
}

/** Takes a place under `name` if fewer than `cap` live holders have one; the token to renew or release it with, or null when full. */
export async function acquireLease(name: string, ttlMs: number, cap = 1, now = Date.now()): Promise<string | null> {
  const token = randomUUID();
  const until = now + ttlMs;
  const doc = await retryingCreateRace(() =>
    leases().findOneAndUpdate(
      { _id: name },
      [
        { $set: { holders: { $filter: { input: { $ifNull: ['$holders', []] }, cond: { $gt: ['$$this.until', now] } } } } },
        {
          $set: {
            holders: { $cond: [{ $lt: [{ $size: '$holders' }, cap] }, { $concatArrays: ['$holders', { $literal: [{ token, until }] }] }, '$holders'] },
            expireAt: { $max: ['$expireAt', new Date(until + KEEP_AFTER_LAST_HOLDER_MS)] },
          },
        },
      ],
      { upsert: true, returnDocument: 'after' }
    )
  );
  return doc?.holders.some((h) => h.token === token) ? token : null;
}

/** Extends a held place; false when it had already lapsed (someone else may hold it now). */
export async function renewLease(name: string, token: string, ttlMs: number, now = Date.now()): Promise<boolean> {
  const until = now + ttlMs;
  const result = await leases().updateOne(
    { _id: name, holders: { $elemMatch: { token, until: { $gt: now } } } },
    { $set: { 'holders.$.until': until }, $max: { expireAt: new Date(until + KEEP_AFTER_LAST_HOLDER_MS) } }
  );
  return result.matchedCount === 1;
}

export async function releaseLease(name: string, token: string): Promise<void> {
  await leases().updateOne({ _id: name }, { $pull: { holders: { token } } });
}

/** Whether anyone holds a place under `name` right now. */
export async function isLeaseHeld(name: string, now = Date.now()): Promise<boolean> {
  const doc = await leases().findOne({ _id: name }, { projection: { holders: 1 } });
  return Boolean(doc?.holders.some((h) => h.until > now));
}

/** Keeps a held place alive for as long as the work takes, so a lapse means its process died; the returned function stops renewing. */
export function keepLeaseAlive(name: string, token: string, ttlMs: number): () => void {
  const timer = setInterval(() => void renewLease(name, token, ttlMs).catch((err) => console.error('[leases] could not renew', name, err)), ttlMs / 3);
  timer.unref();
  return () => clearInterval(timer);
}

/** Runs `work` only if this process wins the name; the others skip it. The lease is kept until it lapses, so a pass runs once per `ttlMs`. */
export async function onceEvery(name: string, ttlMs: number, work: () => Promise<void>): Promise<boolean> {
  if (!(await acquireLease(name, ttlMs))) return false;
  await work();
  return true;
}
