import { timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { processShare, type RateRule } from './limits';
import { col, isDuplicateKeyError } from './mongo';

/**
 * Two kinds of counter, so a limit holds however many processes share the traffic without a database write on every request:
 * - Rules that guard money, accounts and email count in MongoDB, exactly, across every process.
 * - Hot rules (RateRule.hot) run on nearly every request and are only a ceiling against floods, so each process counts its share in memory.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function clearRateLimits(): void {
  buckets.clear();
}

// Returns 0 when the call is allowed (and counts it), otherwise the seconds until the window resets.
export function hit(key: string, rule: RateRule, now = Date.now()): number {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
    return 0;
  }
  if (bucket.count >= processShare(rule.max)) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  bucket.count++;
  return 0;
}

function retryAfterHot(key: string, rule: RateRule, now: number): number {
  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now || bucket.count < processShare(rule.max)) return 0;
  return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
}

// Expired windows are dropped so the map only holds callers active in the last window.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000);
sweeper.unref();

interface SharedBucket {
  _id: string;
  count: number;
  resetAt: number;
  refused: boolean;
  expireAt: Date;
}

const sharedBuckets = () => col<SharedBucket>('rateLimits');
const secondsUntil = (resetAt: number, now: number) => Math.max(1, Math.ceil((resetAt - now) / 1000));

// One atomic step: a new window starts at 1, a full one stays as it is, anything else counts up.
async function countShared(key: string, rule: RateRule, now: number): Promise<SharedBucket> {
  const expired = { $lte: [{ $ifNull: ['$resetAt', 0] }, now] };
  for (let attempt = 0; ; attempt++) {
    try {
      const doc = await sharedBuckets().findOneAndUpdate(
        { _id: key },
        [
          { $set: { refused: { $and: [{ $not: [expired] }, { $gte: ['$count', rule.max] }] } } },
          {
            $set: {
              count: { $cond: [expired, 1, { $cond: ['$refused', '$count', { $add: ['$count', 1] }] }] },
              expireAt: { $cond: [expired, new Date(now + rule.windowMs), '$expireAt'] },
              resetAt: { $cond: [expired, now + rule.windowMs, '$resetAt'] },
            },
          },
        ],
        { upsert: true, returnDocument: 'after' }
      );
      return doc!;
    } catch (err) {
      // Two first hits racing to create the bucket: the loser counts against the one that won.
      if (!isDuplicateKeyError(err) || attempt >= 3) throw err;
    }
  }
}

// As hit, counted across every process.
export async function hitShared(key: string, rule: RateRule, now = Date.now()): Promise<number> {
  const bucket = await countShared(key, rule, now);
  return bucket.refused ? secondsUntil(bucket.resetAt, now) : 0;
}

// Seconds until `key` may act again under `rule`, without counting this look; 0 when it may.
export async function retryAfter(key: string, rule: RateRule, now = Date.now()): Promise<number> {
  const bucket = await sharedBuckets().findOne({ _id: key });
  if (!bucket || bucket.resetAt <= now || bucket.count < rule.max) return 0;
  return secondsUntil(bucket.resetAt, now);
}

// Clears a counter, e.g. failed sign-ins once the right password is given.
export async function forget(key: string): Promise<void> {
  await sharedBuckets().deleteOne({ _id: key });
}

type Scope = 'user' | 'workspace' | 'ip';

/**
 * The caller's address. Behind a front door that forwards every request from its own addresses (the Cloudflare Worker in
 * deploy/local-prod/worker), all callers would share one address and one set of per-address limits, so the front door sends the
 * visitor's address in X-Dubly-Client-IP together with a shared secret (EDGE_SHARED_SECRET); without that secret the header is ignored.
 */
export function clientIp(req: Request): string | null {
  const forwarded = req.get('x-dubly-client-ip')?.trim();
  if (forwarded && fromTrustedEdge(req) && /^[0-9a-fA-F:.]{2,45}$/.test(forwarded)) return forwarded;
  return req.ip ?? req.socket.remoteAddress ?? null;
}

// Whether the request came through Dubly's own front door, which proves itself with the shared secret.
export function fromTrustedEdge(req: Request): boolean {
  const secret = process.env.EDGE_SHARED_SECRET;
  if (!secret) return false;
  const given = Buffer.from(req.get('x-dubly-edge-secret') ?? '');
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function scopeKey(req: Request, scope: Scope): string | null {
  if (scope === 'user') return req.uid ?? null;
  if (scope === 'workspace') return req.workspaceId ?? null;
  return clientIp(req);
}

// Middleware enforcing rules in order; the first exceeded answers 429 with Retry-After, and a refused request uses none of the other rules.
export function rateLimit(name: string, rules: [Scope, RateRule][], message = 'You are doing that too often. Please wait a little and try again.') {
  const refuse = (res: Response, seconds: number) => {
    res.setHeader('Retry-After', String(seconds));
    res.status(429).json({ error: message, code: 'RATE_LIMITED', retryAfterSeconds: seconds });
  };
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const now = Date.now();
      const keyed = rules
        .map(([scope, rule]) => {
          const id = scopeKey(req, scope);
          return id ? { key: `${name}:${scope}:${id}`, rule } : null;
        })
        .filter((k): k is { key: string; rule: RateRule } => k !== null);

      for (const { key, rule } of keyed) {
        const wait = rule.hot ? retryAfterHot(key, rule, now) : await retryAfter(key, rule, now);
        if (wait) return refuse(res, wait);
      }
      for (const { key, rule } of keyed) {
        const wait = rule.hot ? hit(key, rule, now) : await hitShared(key, rule, now);
        // Another process took the last place between the look and the count.
        if (wait) return refuse(res, wait);
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
