#!/usr/bin/env node
/**
 * check_parity — verify the live DB's declarative tables match the committed
 * Drizzle model before baselining (#180). Exit 0 = safe; exit 1 = divergence.
 * Comparison logic lives in parity.mjs (shared with migrate.mjs's guard).
 *   node apps/api/scripts/check_parity.mjs
 */
import { resolve } from 'node:path';
import pg from 'pg';
import { checkParity } from './parity.mjs';

try {
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: resolve(import.meta.dirname, '../../../.env') });
} catch {
  /* rely on process env */
}

const { Client } = pg;
const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const drizzleDir = resolve(import.meta.dirname, '../drizzle');

async function main() {
  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    const { snapshotVersion, problems, messages } = await checkParity(client, drizzleDir);
    console.log(`check_parity → ${pgUrl.replace(/:[^:@/]+@/, ':***@')} (snapshot v${snapshotVersion})`);
    messages.forEach((m) => console.log(m));
    if (problems > 0) {
      console.error(`check_parity: ${problems} divergence(s) — NOT safe to baseline. Reconcile first.`);
      process.exit(1);
    }
    console.log('check_parity: OK — live schema matches the Drizzle model; safe to baseline.');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('check_parity failed:', err);
  process.exit(1);
});
