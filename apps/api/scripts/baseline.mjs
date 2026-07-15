#!/usr/bin/env node
/**
 * baseline — seed Drizzle's migration ledger for an EXISTING database so that
 * `migrate()` (db:migrate:deploy) SKIPS migrations whose schema is already
 * present, instead of trying `CREATE TABLE` on tables that already exist.
 *
 * This is the one-time step for cutting a populated DB (built by the old
 * psql/schema.sql path) over to Direction B. Run it ONCE, before the first
 * Direction-B deploy, AFTER `db:check:parity` passes.
 *
 * IMPORTANT: run this as the **app DB role** (the same role db:migrate:deploy
 * uses) — the connecting role creates + owns the `drizzle` schema, which avoids
 * a `permission denied for schema drizzle` when the migrator later runs as that
 * role. Idempotent.
 *
 *   node apps/api/scripts/baseline.mjs [--up-to <tag>] [--dry-run]
 */
import { resolve } from 'node:path';
import pg from 'pg';
import { readJournalEntries, seedLedger } from './drizzle_baseline.mjs';

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

let upTo = null;
let dryRun = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--up-to') upTo = argv[++i];
  else if (argv[i] === '--dry-run') dryRun = true;
  else if (argv[i] === '--') continue;
  else throw new Error(`unknown arg: ${argv[i]}`);
}

async function main() {
  const entries = await readJournalEntries(drizzleDir);
  console.log(`baseline → ${pgUrl.replace(/:[^:@/]+@/, ':***@')}${dryRun ? ' (dry-run)' : ''}`);

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    // Human-driven: baseline ALL entries (up to --up-to) — safe because the
    // operator runs db:check:parity first to confirm the full schema matches.
    const { seeded, skipped } = await seedLedger(client, drizzleDir, {
      entries,
      upTo,
      dryRun,
      log: (m) => console.log(m),
    });
    console.log(`baseline: seeded=${seeded} already-present=${skipped}${dryRun ? ' (dry-run — no writes)' : ''}`);
  } finally {
    await client.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('baseline failed:', err);
    process.exit(1);
  });
