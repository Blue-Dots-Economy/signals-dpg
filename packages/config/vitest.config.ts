import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // Explicit `include` so untested modules count as uncovered (see
      // packages/schemas/vitest.config.ts).
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/index.ts'],
    },
  },
  resolve: {
    alias: {
      '@dpg/schemas': new URL('../../packages/schemas/src', import.meta.url).pathname,
      '@dpg/database': new URL('../../packages/database/src', import.meta.url).pathname,
      '@dpg/config': new URL('./src', import.meta.url).pathname,
    },
  },
});
