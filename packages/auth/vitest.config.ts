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
  resolve: {
    // `plugins/unified_otp.ts` imports `@dpg/schemas`, which previously existed
    // only as a tsconfig path — so the package's largest module was not
    // importable under its own vitest ("Cannot find package '@dpg/schemas'")
    // and sat at 0%, while apps/api (which does alias) imports it fine.
    // `@dpg/database` is aliased too because the schemas barrel re-exports
    // modules that import it. Mirrors the alias block in apps/api.
    alias: {
      '@dpg/schemas': new URL('../schemas/src', import.meta.url).pathname,
      '@dpg/database': new URL('../database/src', import.meta.url).pathname,
    },
  },
});
