import { defineConfig } from 'vitest/config';

// The release gate's performance test (`npm run test:perf`), kept out of `npm test` because it renders whole dubs.
export default defineConfig({
  test: {
    include: ['server/perf/**/*.perf.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 60 * 60_000,
    hookTimeout: 60_000,
    setupFiles: ['server/test/setup.ts'],
  },
});
