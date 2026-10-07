import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/__tests__/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
  resolve: {
    alias: {
      '@dpg/notification': new URL('../../packages/notification/src', import.meta.url).pathname,
    },
  },
});
