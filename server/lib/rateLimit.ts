import type { NextFunction, Request, Response } from 'express';
import type { RateRule } from './limits';

// In-memory fixed-window counters, enough for the single-instance deployment (multiple instances would need a shared store).
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
  if (bucket.count >= rule.max) return Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
  bucket.count++;
  return 0;
}

// Expired windows are dropped so the map only holds callers active in the last window.
const sweeper = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets) if (bucket.resetAt <= now) buckets.delete(key);
}, 60_000);
sweeper.unref();

type Scope = 'user' | 'workspace' | 'ip';

function scopeKey(req: Request, scope: Scope): string | null {
  if (scope === 'user') return req.uid ?? null;
  if (scope === 'workspace') return req.workspaceId ?? null;
  return req.ip ?? req.socket.remoteAddress ?? null;
}

// Middleware enforcing rules in order; the first exceeded answers 429 with Retry-After, and a refused request uses none of the other rules.
export function rateLimit(name: string, rules: [Scope, RateRule][], message = 'You are doing that too often. Please wait a little and try again.') {
  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const keyed = rules
      .map(([scope, rule]) => {
        const id = scopeKey(req, scope);
        return id ? { key: `${name}:${scope}:${id}`, rule } : null;
      })
      .filter((k): k is { key: string; rule: RateRule } => k !== null);

    for (const { key, rule } of keyed) {
      const bucket = buckets.get(key);
      if (bucket && bucket.resetAt > now && bucket.count >= rule.max) {
        const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
        res.setHeader('Retry-After', String(retryAfter));
        res.status(429).json({ error: message, code: 'RATE_LIMITED', retryAfterSeconds: retryAfter });
        return;
      }
    }
    for (const { key, rule } of keyed) hit(key, rule, now);
    next();
  };
}
