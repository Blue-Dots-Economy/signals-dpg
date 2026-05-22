import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['src/**/__tests__/**/*.integration.test.ts'],
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
