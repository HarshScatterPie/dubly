import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { sharedInvalidator, startCacheBus, stopCacheBus } from './cacheBus';
import { col } from './mongo';

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 25));
  expect(check()).toBe(true);
};

describe('cache invalidation across processes', () => {
  const cleared: (string | null)[] = [];
  const invalidate = sharedInvalidator('test-channel', (key) => cleared.push(key));

  beforeAll(async () => {
    startCacheBus();
    // The stream only sees what happens after it is open, so wait until an event comes through.
    for (let i = 0; i < 100 && !cleared.includes('warm-up'); i++) {
      await col('cacheEvents').insertOne({ channel: 'test-channel', key: 'warm-up', from: 'another-process', at: new Date() });
      await new Promise((r) => setTimeout(r, 50));
    }
  });
  afterAll(async () => {
    await stopCacheBus();
  });
  beforeEach(() => {
    cleared.length = 0;
  });

  it('clears an entry when another process says so', async () => {
    await col('cacheEvents').insertOne({ channel: 'test-channel', key: 'k1', from: 'another-process', at: new Date() });
    await until(() => cleared.includes('k1'));
  });

  it('clears the whole cache on a null key', async () => {
    await col('cacheEvents').insertOne({ channel: 'test-channel', key: null, from: 'another-process', at: new Date() });
    await until(() => cleared.includes(null));
  });

  it('clears at once in the process making the change, and does not clear twice from its own event', async () => {
    invalidate('k2');
    expect(cleared).toEqual(['k2']);
    // A later event from elsewhere arrives, so its own would have too.
    await col('cacheEvents').insertOne({ channel: 'test-channel', key: 'after', from: 'another-process', at: new Date() });
    await until(() => cleared.includes('after'));
    expect(cleared.filter((key) => key === 'k2')).toHaveLength(1);
  });

  it('ignores channels this process has no cache for', async () => {
    await col('cacheEvents').insertOne({ channel: 'nobody-here', key: 'x', from: 'another-process', at: new Date() });
    await col('cacheEvents').insertOne({ channel: 'test-channel', key: 'after-unknown', from: 'another-process', at: new Date() });
    await until(() => cleared.includes('after-unknown'));
    expect(cleared).toEqual(['after-unknown']);
  });
});
