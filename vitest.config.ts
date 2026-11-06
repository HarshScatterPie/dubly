import { defineConfig } from 'vitest/config';

// Server tests run against a real MongoDB replica set in a `_test` database (see server/test/setup.ts); files run one at a time because they share it.
export default defineConfig({
  test: {
    include: ['server/**/*.test.ts'],
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    setupFiles: ['server/test/setup.ts'],
    // On GitHub Actions failures also become annotations on the run.
    reporters: process.env.GITHUB_ACTIONS ? ['default', 'github-actions'] : ['default'],
  },
});
