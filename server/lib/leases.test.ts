import { beforeEach, describe, expect, it } from 'vitest';
import { acquireLease, onceEvery, releaseLease, renewLease } from './leases';
import { resetEmulators } from '../test/helpers';

describe('leases', () => {
  beforeEach(async () => {
    await resetEmulators();
  });

  it('never gives out more places than the cap, however many ask at once', async () => {
    const tokens = await Promise.all(Array.from({ length: 12 }, () => acquireLease('render', 60_000, 3)));
    expect(tokens.filter(Boolean)).toHaveLength(3);
  });

  it('gives a place back when it is released', async () => {
    const token = (await acquireLease('one', 60_000))!;
    expect(await acquireLease('one', 60_000)).toBeNull();
    await releaseLease('one', token);
    expect(await acquireLease('one', 60_000)).not.toBeNull();
  });

  it('frees the place of a holder that died, once its time runs out', async () => {
    expect(await acquireLease('crash', 1000, 1, 10_000)).not.toBeNull();
    expect(await acquireLease('crash', 1000, 1, 10_500)).toBeNull();
    expect(await acquireLease('crash', 1000, 1, 11_000)).not.toBeNull();
  });

  it('renews a live lease, and refuses one that has lapsed', async () => {
    const token = (await acquireLease('job', 1000, 1, 10_000))!;
    expect(await renewLease('job', token, 1000, 10_500)).toBe(true);
    // Renewed to 11,500, so a claim at 11,200 still finds it taken.
    expect(await acquireLease('job', 1000, 1, 11_200)).toBeNull();
    expect(await renewLease('job', token, 1000, 12_000)).toBe(false);
  });

  it('runs a periodic pass in one process only', async () => {
    let runs = 0;
    const results = await Promise.all(Array.from({ length: 5 }, () => onceEvery('sweep', 60_000, async () => void runs++)));
    expect(runs).toBe(1);
    expect(results.filter(Boolean)).toHaveLength(1);
  });
});
