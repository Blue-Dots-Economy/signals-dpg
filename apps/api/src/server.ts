// Must be the first import: @/config parses process.env when it is evaluated,
// so a local .env must be loaded before it. (`pnpm dev:api` also pre-loads the
// root .env; direct invocations rely on this.)
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
    // Drain the HTTP server first, then close the Postgres pool and Redis.
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
