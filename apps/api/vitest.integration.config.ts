/**
 * Integration-test runner config.
 *
 * The default vitest.config.ts excludes *.integration.test.ts so `pnpm test`
 * stays unit-only and runs without a live DB. Integration tests opt-in via
 * this config, which inverts the filter: it ONLY picks up *.integration.test.ts.
 *
 * Run:
 *   pnpm --filter api test:integration
 *
 * Requires a running local stack (docker compose up -d db redis) and the
 * env vars each integration suite documents in its header.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.integration.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@': new URL('./src', import.meta.url).pathname,
      '@api': new URL('./', import.meta.url).pathname,
      '@dpg/schemas': new URL('../../packages/schemas/src', import.meta.url)
        .pathname,
      '@dpg/config': new URL('../../packages/config/src', import.meta.url)
        .pathname,
      '@dpg/database': new URL('../../packages/database/src', import.meta.url)
        .pathname,
    },
  },
});
