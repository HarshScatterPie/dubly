import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_HOLD_MS, MIN_HOLD_MS, releaseChangeWaits, revisionOf, waitForChange } from './changeWait';

interface Progress {
  percent: number;
  done?: boolean;
}

describe('waiting for a change', () => {
  let current: Progress | null;
  let reads: number;
  const watch = (since: string) => ({
    read: async () => {
      reads++;
      return current;
    },
    revision: (value: Progress) => revisionOf(value.percent),
    isFinal: (value: Progress) => value.done === true,
    since,
  });
  const ignoreClose = () => undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    current = { percent: 10 };
    reads = 0;
  });
  afterEach(() => {
    releaseChangeWaits();
    vi.useRealTimers();
  });

  it('answers at once on a first request, which has no revision yet', async () => {
    await expect(waitForChange(watch(''), ignoreClose)).resolves.toEqual({ percent: 10 });
  });

  it('answers at once when the work is already finished, or gone', async () => {
    current = { percent: 100, done: true };
    await expect(waitForChange(watch(revisionOf(10)), ignoreClose)).resolves.toEqual({ percent: 100, done: true });
    current = null;
    await expect(waitForChange(watch(revisionOf(10)), ignoreClose)).resolves.toBeNull();
  });

  it('holds new progress back for the minimum, so a busy job is not one answer a second', async () => {
    let answer: Progress | null | undefined;
    void waitForChange(watch(revisionOf(10)), ignoreClose).then((value) => (answer = value));
    await vi.advanceTimersByTimeAsync(100);
    current = { percent: 20 };
    await vi.advanceTimersByTimeAsync(MIN_HOLD_MS - 2000);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(answer).toEqual({ percent: 20 });
  });

  it('answers a finished job on the next look, without waiting out the hold', async () => {
    let answer: Progress | null | undefined;
    void waitForChange(watch(revisionOf(10)), ignoreClose).then((value) => (answer = value));
    await vi.advanceTimersByTimeAsync(100);
    current = { percent: 100, done: true };
    await vi.advanceTimersByTimeAsync(1500);
    expect(answer).toEqual({ percent: 100, done: true });
  });

  it('gives up holding after the maximum even with no change', async () => {
    let answer: Progress | null | undefined;
    void waitForChange(watch(revisionOf(10)), ignoreClose).then((value) => (answer = value));
    await vi.advanceTimersByTimeAsync(MAX_HOLD_MS - 2000);
    expect(answer).toBeUndefined();
    await vi.advanceTimersByTimeAsync(3000);
    expect(answer).toEqual({ percent: 10 });
  });

  it('stops looking once the client has left', async () => {
    let leave!: () => void;
    const done = waitForChange(watch(revisionOf(10)), (stop) => (leave = stop));
    await vi.advanceTimersByTimeAsync(0);
    leave();
    await done;
    const readsWhenLeft = reads;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(reads).toBe(readsWhenLeft);
  });

  it('answers everyone at once for a shutdown', async () => {
    const waiting = waitForChange(watch(revisionOf(10)), ignoreClose);
    await vi.advanceTimersByTimeAsync(0);
    releaseChangeWaits();
    await expect(waiting).resolves.toEqual({ percent: 10 });
  });

  it('passes a failed read on to the request', async () => {
    const failing = { ...watch(revisionOf(10)), read: vi.fn().mockResolvedValueOnce({ percent: 10 }).mockRejectedValue(new Error('database down')) };
    const result = waitForChange(failing, ignoreClose);
    const caught = result.catch((err: Error) => err.message);
    await vi.advanceTimersByTimeAsync(1500);
    await expect(caught).resolves.toBe('database down');
  });
});
