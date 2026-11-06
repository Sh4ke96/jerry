import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests spawn Core processes and share nothing, but keep them predictable on Windows.
    fileParallelism: false,
  },
});
