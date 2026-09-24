import { defineConfig } from 'vitest/config';

// Server tests run against the Firebase emulators (see `npm test`); files run one at a time because they share one emulator.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['server/test/setup.ts'],
  },
});
