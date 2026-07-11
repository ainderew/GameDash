import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared/src', import.meta.url)),
    },
  },
  test: {
    globals: true,
    // Plain Node, no jsdom — proving these tests pass headless IS the point of this package.
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
