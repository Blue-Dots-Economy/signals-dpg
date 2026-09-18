import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts', 'src/scripts/backfill_lifecycle.ts'],
  tsconfig: './tsconfig.json',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
  // The email copy and SMS template defaults are read at runtime relative to
  // the bundle (import.meta.url), so ship both next to dist/server.js
  // (#529 email, #595 SMS).
  onSuccess: [
    'cp src/notifications/email/messages.default.properties dist/messages.default.properties',
    'cp src/notifications/sms/sms.default.properties dist/sms.default.properties',
  ].join(' && '),
  esbuildOptions(options) {
    options.alias = {
      ...options.alias,
      '@': resolve('src'),
      '@api': resolve('.'),
    };
  },
  external: [
    'fastify',
    '@fastify/cors',
    '@fastify/swagger',
    '@scalar/fastify-api-reference',
    'fastify-qs',
    'fastify-type-provider-zod',
    'drizzle-orm',
    'drizzle-orm/*',
    'pg',
    'pg/*',
    'ioredis',
    'dotenv'
  ],
});
