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
    setupFiles: ['./vitest.setup.ts'],
    // Every integration suite boots a real Fastify app on API_PORT (default
    // 2742), which the bundled network configs' instance_url also hard-codes.
    // Run in parallel they race for the port (EADDRINUSE), so run serially.
    fileParallelism: false,
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
      // The real app needs the full workspace alias surface; unit tests stub
      // these modules at the boundary.
      '@dpg/auth': new URL('../../packages/auth/src', import.meta.url)
        .pathname,
      '@dpg/notification': new URL(
        '../../packages/notification/src',
        import.meta.url,
      ).pathname,
      '@dpg/match_score': new URL(
        '../../packages/match_score/src',
        import.meta.url,
      ).pathname,
    },
  },
});
