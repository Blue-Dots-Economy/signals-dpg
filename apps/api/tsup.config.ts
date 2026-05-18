import { resolve } from 'node:path';

import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/server.ts'],
  tsconfig: './tsconfig.json',
  format: ['esm'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  sourcemap: true,
  dts: false,
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
