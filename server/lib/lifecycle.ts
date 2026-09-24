import type { NextFunction, Request, Response } from 'express';

// Process-wide shutdown state: once draining, no new long-running work is accepted and in-flight work is awaited.
let draining = false;
const inFlight = new Set<Promise<unknown>>();

export function isDraining(): boolean {
  return draining;
}

export function startDraining(): void {
  draining = true;
}

// Test hook: a fresh app in the same test process starts accepting work again.
export function resetLifecycleForTests(): void {
  draining = false;
  inFlight.clear();
}

// Registers background work (a dub pipeline) so shutdown can wait for it.
export function trackBackgroundWork<T>(work: Promise<T>): Promise<T> {
  inFlight.add(work);
  const done = () => inFlight.delete(work);
  work.then(done, done);
  return work;
}

export function backgroundWorkCount(): number {
  return inFlight.size;
}

// Resolves true when all tracked work finished within the window, false if the window ran out first.
export async function waitForBackgroundWork(timeoutMs: number): Promise<boolean> {
  if (inFlight.size === 0) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const all = Promise.allSettled([...inFlight]).then(() => true as const);
  const finished = await Promise.race([all, timeout]);
  clearTimeout(timer);
  return finished;
}

// Put in front of any route that starts heavy work, so a deploy's shutdown window is not extended by new jobs.
export function refuseWhenDraining(_req: Request, res: Response, next: NextFunction): void {
  if (draining) {
    res.setHeader('Retry-After', '30');
    res.status(503).json({ error: 'Dubly is restarting for an update. Please try again in a minute.', code: 'SERVER_RESTARTING' });
    return;
  }
  next();
}
