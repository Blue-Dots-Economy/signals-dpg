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
    await app.close();
  } catch (err) {
    app.log.error(err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
