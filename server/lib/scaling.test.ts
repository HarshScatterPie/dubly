import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { col, resetDatabase } from '../test/helpers';
import { AiBusyError, isQuotaError, reportQuotaHit, setModelRpmForTests, takeTurn } from './aiPacing';
import { decideScale, SCALE, type ScaleInput } from './autoscale';
import { beat } from './instances';
import { limits, processShare } from './limits';
import { acquireSlot, setFreeMemoryForTests, SlotBroker } from './machineSlots';

const MB = 1024 * 1024;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  await resetDatabase();
});
afterEach(() => {
  setModelRpmForTests(null);
  setFreeMemoryForTests(null);
});

describe('AI model pacing', () => {
  it('spaces calls to a model at its quota, in arrival order, however many callers ask at once', async () => {
    setModelRpmForTests({ 'paced-model': 600 }); // one turn every 100 ms
    const started = Date.now();
    const at: number[] = [];
    await Promise.all(Array.from({ length: 5 }, () => takeTurn('paced-model').then(() => at.push(Date.now() - started))));
    at.sort((a, b) => a - b);
    expect(at[0]).toBeLessThan(80);
    for (let i = 1; i < at.length; i++) expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(85);
    expect(at[4]).toBeGreaterThanOrEqual(390);
  });

  it('lets an unpaced model through at once, and holds every caller while the provider says it is out of quota', async () => {
    let started = Date.now();
    await takeTurn('unpaced-model');
    expect(Date.now() - started).toBeLessThan(80);
    await reportQuotaHit('unpaced-model', 200);
    started = Date.now();
    await Promise.all([takeTurn('unpaced-model'), takeTurn('unpaced-model')]);
    expect(Date.now() - started).toBeGreaterThanOrEqual(180);
  });

  it('answers a call that cannot wait that long with AiBusyError at once, and keeps its turn for others', async () => {
    setModelRpmForTests({ 'slow-model': 60 }); // one turn a second
    await takeTurn('slow-model');
    const asked = Date.now();
    await expect(takeTurn('slow-model', { maxWaitMs: 100 })).rejects.toBeInstanceOf(AiBusyError);
    expect(Date.now() - asked).toBeLessThan(80);
    // The refused call took no turn: the next one waits one interval, not two.
    const started = Date.now();
    await takeTurn('slow-model', { maxWaitMs: 5000 });
    expect(Date.now() - started).toBeLessThan(1300);
  });

  it('knows a quota answer from each provider', () => {
    expect(isQuotaError(Object.assign(new Error('8 RESOURCE_EXHAUSTED: Quota exceeded'), { code: 8 }))).toBe(true);
    expect(isQuotaError(Object.assign(new Error('Too Many Requests'), { status: 429 }))).toBe(true);
    expect(isQuotaError(new Error('400 INVALID_ARGUMENT'))).toBe(false);
    expect(isQuotaError(new Error('This API requires a quota project, which is not set'))).toBe(false);
  });
});

describe("the machine's slots", () => {
  it('never hands out more than the budget, serves waiters first come first served, and takes back a stopped process’s slots', async () => {
    const saved = limits.maxActiveDubs;
    limits.maxActiveDubs = 2;
    setFreeMemoryForTests(() => 8000 * MB);
    try {
      const broker = new SlotBroker();
      expect(await broker.acquire('dub', 'a', 0)).toBe(true);
      expect(await broker.acquire('dub', 'b', 0)).toBe(true);
      expect(await broker.acquire('dub', 'c', 0)).toBe(false);
      const order: string[] = [];
      const c = broker.acquire('dub', 'c', 5000).then((ok) => ok && order.push('c'));
      const d = broker.acquire('dub', 'd', 5000).then((ok) => ok && order.push('d'));
      broker.releaseOwner('a');
      await c;
      expect(broker.stats().dub).toBe(2);
      broker.release('dub', 'b');
      await d;
      expect(order).toEqual(['c', 'd']);
    } finally {
      limits.maxActiveDubs = saved;
    }
  });

  it('starts work only while memory is free, one at a time when it is short, and the rest once it frees up', async () => {
    let freeMb = 400; // under MIN_FREE_MEMORY_MB, over a quarter of it
    setFreeMemoryForTests(() => freeMb * MB);
    const broker = new SlotBroker();
    expect(await broker.acquire('heavy', 'a', 0)).toBe(true);
    expect(await broker.acquire('heavy', 'b', 0)).toBe(false);
    const waiting = broker.acquire('heavy', 'b', 10_000);
    freeMb = 4000;
    // Nothing was released: the broker looks again by itself.
    expect(await waiting).toBe(true);
  });

  it('gives up a wait for a slot when it runs out, holding nothing', async () => {
    const saved = limits.maxHeavyRequests;
    limits.maxHeavyRequests = 1;
    setFreeMemoryForTests(() => 8000 * MB);
    try {
      const release = await acquireSlot('heavy');
      expect(release).not.toBeNull();
      expect(await acquireSlot('heavy', { waitMs: 50 })).toBeNull();
      release!();
      const again = await acquireSlot('heavy');
      expect(again).not.toBeNull();
      again!();
    } finally {
      limits.maxHeavyRequests = saved;
    }
  });
});

describe('adding and retiring processes', () => {
  const base = (over: Partial<ScaleInput> = {}): ScaleInput => ({
    now: 1_000_000,
    count: 2,
    min: 2,
    max: 7,
    freeMb: 4000,
    minFreeMb: 1024,
    processMb: 300,
    loads: [
      { id: 1, elu: 0.8, lagMs: 30, busy: 1 },
      { id: 2, elu: 0.7, lagMs: 40, busy: 0 },
    ],
    lastChangeAt: 0,
    busySince: 1_000_000 - SCALE.busyForMs,
    quietSince: null,
    ...over,
  });

  it('adds one process when they have been busy for a while, with room and memory for it', () => {
    expect(decideScale(base())).toEqual({ action: 'up' });
    expect(decideScale(base({ busySince: 1_000_000 - 1000 }))).toEqual({ action: 'hold' });
    expect(decideScale(base({ count: 7 }))).toEqual({ action: 'hold' });
    expect(decideScale(base({ freeMb: 1200 }))).toEqual({ action: 'hold' });
    expect(decideScale(base({ lastChangeAt: 1_000_000 - 5000 }))).toEqual({ action: 'hold' });
  });

  it('retires an idle process after three quiet minutes, never one with work running and never below the minimum', () => {
    const quiet = { loads: [{ id: 1, elu: 0.05, lagMs: 2, busy: 1 }, { id: 2, elu: 0.02, lagMs: 1, busy: 0 }, { id: 3, elu: 0.01, lagMs: 1, busy: 2 }], busySince: null };
    expect(decideScale(base({ ...quiet, count: 3, quietSince: 1_000_000 - SCALE.quietForMs }))).toEqual({ action: 'down', id: 2 });
    expect(decideScale(base({ ...quiet, count: 3, quietSince: 1_000_000 - 60_000 }))).toEqual({ action: 'hold' });
    expect(decideScale(base({ ...quiet, count: 2, quietSince: 1_000_000 - SCALE.quietForMs }))).toEqual({ action: 'hold' });
    const allBusy = { loads: quiet.loads.map((l) => ({ ...l, busy: 1 })), busySince: null };
    expect(decideScale(base({ ...allBusy, count: 3, quietSince: 1_000_000 - SCALE.quietForMs }))).toEqual({ action: 'hold' });
  });

  it('gives an idle process’s memory back when the machine runs short, even while busy', () => {
    expect(decideScale(base({ count: 4, freeMb: 300 }))).toEqual({ action: 'down', id: 2 });
  });
});

describe('counting live processes', () => {
  it('counts every process with a fresh heartbeat, on any machine, and none that stopped beating', async () => {
    const saved = limits.totalProcesses;
    try {
      const now = new Date();
      await col('instances').insertMany([
        { _id: 'other-host:1' as never, host: 'other-host', pid: 1, at: now, expireAt: new Date(now.getTime() + 90_000) },
        { _id: 'other-host:2' as never, host: 'other-host', pid: 2, at: new Date(now.getTime() - 120_000), expireAt: new Date(now.getTime() + 90_000) },
      ]);
      expect(await beat(now)).toBe(2);
      expect(limits.totalProcesses).toBe(2);
      // Each process's share of an in-memory flood ceiling follows the live count.
      expect(processShare(3000)).toBe(3000);
      limits.totalProcesses = 8;
      expect(processShare(3000)).toBe(750);
    } finally {
      limits.totalProcesses = saved;
    }
  });
});

// Waits a moment so a timer-driven assertion above never races the next test's reset.
afterEach(() => sleep(1));
