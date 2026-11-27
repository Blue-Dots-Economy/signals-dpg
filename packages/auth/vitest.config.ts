import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/__tests__/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // Explicit `include` so untested modules count as uncovered (see
      // packages/schemas/vitest.config.ts).
      include: ['src/**/*.ts', 'plugins/**/*.ts', 'utils/**/*.ts'],
      exclude: ['**/__tests__/**', 'src/index.ts'],
    },
  },
  resolve: {
    // `@dpg/database` is aliased because the schemas barrel re-exports modules
    // that import it. Mirrors the alias block in apps/api.
    alias: {
      '@dpg/schemas': new URL('../schemas/src', import.meta.url).pathname,
      '@dpg/database': new URL('../database/src', import.meta.url).pathname,
    },
  },
});
