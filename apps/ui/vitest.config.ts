import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@dpg/schemas/location_fields',
        replacement: path.resolve(__dirname, '../../packages/schemas/src/location_fields.ts'),
      },
      {
        find: '@dpg/schemas/uri_fields',
        replacement: path.resolve(__dirname, '../../packages/schemas/src/uri_fields.ts'),
      },
      { find: /^@dpg\/(.*)$/, replacement: path.resolve(__dirname, '../../packages/$1/src') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  test: {
    environment: 'happy-dom',
    globals: false,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Headroom for individual tests when workers contend for CPU (default 5s).
    // Pairs with the RTL asyncUtilTimeout bump in setup.ts.
    testTimeout: 15000,
    hookTimeout: 15000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test/**',
        // Generated shadcn component kit — installed boilerplate, not app
        // logic. Already in sonar.coverage.exclusions; mirrored here so the
        // local number and the SonarCloud number agree.
        'src/components/ui/**',
        // Vite entry points: the two bootstrap files (default + tourist app).
        // Equivalent to apps/api/src/server.ts — nothing meaningfully
        // unit-testable, exercised by actually starting the app.
        'src/main.tsx',
        'src/tourist/main.tourist.tsx',
      ],
    },
  },
});
