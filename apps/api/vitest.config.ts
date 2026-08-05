import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['src/**/__tests__/**/*.integration.test.ts'],
    environment: 'node',
    globals: false,
    setupFiles: ['./vitest.setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts', 'plugins/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'plugins/**/__tests__/**'],
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
