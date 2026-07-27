// Must be the first import: @/app (below) transitively pulls in @/config,
// whose module-top-level loadEnv() parses process.env immediately on
// evaluation. dotenv/config has to run before that or a local .env's values
// won't be visible yet. (`pnpm dev:api` / `build:api` already pre-load the
// root .env via scripts/turbo-with-root-env.mjs before this process starts,
// but direct invocations — e.g. a future `node dist/server.js` against a
// local .env — depend on this import order.)
import 'dotenv/config';
import { apiConfig } from '@/config';
import { buildApp } from '@/app';
import { pool } from '@api/db/postgres/drizzle_config';
import { redis } from '@api/db/secondary/redis';

const app = await buildApp();

await app
  .listen({
    port: apiConfig.port,
    host: '0.0.0.0',
  })
  .then((endpoint) => console.log('Server Endpoint: ', endpoint))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;

  app.log.info(`Shutting down (${signal})`);

  try {
    // Drain the HTTP server first (stop accepting requests), then close the
    // backing connections that were previously leaked on shutdown: the Postgres
    // pool and the Redis client.
    await app.close();
    await pool.end();
    await redis.quit();
  } catch (err) {
    app.log.error(err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
