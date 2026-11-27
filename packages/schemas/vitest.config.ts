import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // Without an explicit `include`, v8 reports only files a test loaded, so
      // untested modules drop out of the percentage while SonarCloud counts
      // them as 0%.
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@dpg/database': new URL('../../packages/database/src', import.meta.url).pathname,
    },
  },
});
