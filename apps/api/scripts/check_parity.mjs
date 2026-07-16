#!/usr/bin/env node
/**
 * check_parity — verify the live database's Drizzle-owned tables match the
 * committed Drizzle model BEFORE baselining (#180).
 *
 * Baselining tells the migrator "these migrations are already applied." That is
 * only truthful if the live schema actually matches the model. This compares
 * the latest Drizzle snapshot (apps/api/drizzle/meta/*_snapshot.json) against
 * the live DB's information_schema and reports divergences (missing tables,
 * missing columns, nullability mismatches). Extra columns are informational.
 *
 * The comparison itself lives in scripts/parity.mjs (shared with migrate.mjs's
 * pre-baseline guard) so the two cannot drift.
 *
 * Exit 0 = safe to baseline; exit 1 = divergence found.
 *
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
