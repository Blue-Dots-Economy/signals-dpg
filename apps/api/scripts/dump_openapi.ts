/**
 * Dumps the code-generated OpenAPI spec to the repo root ./openapi.json
 * (committed; CI drift-checks it). Loads the committed dump env FIRST so
 * config parses without a real environment; dotenv does not override vars
 * already set in the shell.
 */
import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { writeFile } from 'node:fs/promises';

loadEnv({ path: fileURLToPath(new URL('./dump_openapi.env', import.meta.url)) });

const { buildApp } = await import('../src/app.js');
const app = await buildApp();
await app.ready();
const spec = app.swagger();
await writeFile(
  new URL('../../../openapi.json', import.meta.url),
  JSON.stringify(spec, null, 2) + '\n',
);
await app.close();
console.log(`openapi.json written (${Object.keys((spec as { paths: object }).paths).length} paths)`);
process.exit(0); // ioredis/better-auth may hold live handles — exit explicitly
