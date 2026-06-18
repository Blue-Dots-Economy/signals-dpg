import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@dpg/schemas': new URL('../../packages/schemas/src', import.meta.url).pathname,
      '@dpg/database': new URL('../../packages/database/src', import.meta.url).pathname,
      '@dpg/config': new URL('./src', import.meta.url).pathname,
    },
  },
});
