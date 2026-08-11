import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `plugins/auth/` sits outside src/ (a structural quirk documented in
    // apps/api/CLAUDE.md), so tests there were invisible to the runner: the
    // coverage `include` below already counts `plugins/**/*.ts`, which is why
    // auth_middleware.ts reported 0% despite having a passing test file.
    // Naming a path on the CLI bypasses `include`, so this only shows up on a
    // full run.
    include: [
      'src/**/__tests__/**/*.test.ts',
      'plugins/**/__tests__/**/*.test.ts',
    ],
    exclude: [
      'src/**/__tests__/**/*.integration.test.ts',
      'plugins/**/__tests__/**/*.integration.test.ts',
    ],
    environment: 'node',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'plugins/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'plugins/**/__tests__/**',
        // Bootstrap entry: dotenv import-order, buildApp(), listen() and the
        // shutdown hooks. Nothing here is meaningfully unit-testable — it is
        // exercised by actually starting the app.
        'src/server.ts',
        // One-off operational CLI commands. Their real logic lives in the pure
        // modules they call (e.g. classify_item), which are tested directly.
        'src/scripts/**',
      ],
    },
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      '@api': new URL('./', import.meta.url).pathname,
      '@dpg/auth': new URL('../../packages/auth/src', import.meta.url).pathname,
      '@dpg/notification': new URL(
        '../../packages/notification/src',
        import.meta.url,
      ).pathname,
      '@dpg/schemas': new URL('../../packages/schemas/src', import.meta.url)
        .pathname,
      '@dpg/config': new URL('../../packages/config/src', import.meta.url)
        .pathname,
      '@dpg/database': new URL('../../packages/database/src', import.meta.url)
        .pathname,
      '@dpg/match_score': new URL(
        '../../packages/match_score/src',
        import.meta.url,
      ).pathname,
    },
  },
});
