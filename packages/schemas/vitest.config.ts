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
      // Without an explicit `include`, the v8 provider only reports files that
      // were actually LOADED by a test — a module with no tests is silently
      // absent from the denominator (and from lcov), so the percentage flatters
      // itself while SonarCloud counts those files as 0%. Naming the whole
      // source tree keeps the local number honest and matches what Sonar sees.
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
