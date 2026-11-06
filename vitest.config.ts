import vueJsx from '@vitejs/plugin-vue-jsx';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Dashboard component tests are TSX compiled by the same Vue JSX plugin as the production build.
  plugins: [vueJsx()],
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // Integration tests spawn Core processes and share nothing, but keep them predictable on Windows.
    fileParallelism: false,
  },
});
