import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/__tests__/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      // See the note in packages/schemas/vitest.config.ts: without an explicit
      // `include`, untested modules vanish from the denominator instead of
      // counting as uncovered. `plugins/` and `utils/` sit outside src/ here.
      include: ['src/**/*.ts', 'plugins/**/*.ts', 'utils/**/*.ts'],
      exclude: ['**/__tests__/**', 'src/index.ts'],
    },
  },
});
