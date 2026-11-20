import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
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
      // Still emit the lcov report when some tests fail. Without this, a single
      // failing test zeroes the entire api coverage upload — SonarCloud then
      // reports 0% for every api file even though the rest of the suite ran.
      reportOnFailure: true,
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
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@api': fileURLToPath(new URL('./', import.meta.url)),
      '@dpg/auth': fileURLToPath(new URL('../../packages/auth/src', import.meta.url)),
      '@dpg/notification': fileURLToPath(
        new URL('../../packages/notification/src', import.meta.url),
      ),
      '@dpg/schemas': fileURLToPath(
        new URL('../../packages/schemas/src', import.meta.url),
      ),
      '@dpg/config': fileURLToPath(
        new URL('../../packages/config/src', import.meta.url),
      ),
      '@dpg/database': fileURLToPath(
        new URL('../../packages/database/src', import.meta.url),
      ),
      '@dpg/match_score': fileURLToPath(
        new URL('../../packages/match_score/src', import.meta.url),
      ),
    },
  },
});
