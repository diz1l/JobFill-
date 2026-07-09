import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['shared/**'],
      exclude: ['shared/**/*.test.ts'],
      thresholds: {
        lines: 90,
        branches: 80,
      },
    },
  },
  resolve: {
    alias: {
      '@@': new URL('.', import.meta.url).pathname,
    },
  },
});
