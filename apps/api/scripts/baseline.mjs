#!/usr/bin/env node
/**
 * baseline — manually seed the Drizzle ledger for an existing DB so migrate()
 * skips already-present schema. Run once, as the app DB role, after db:check:parity.
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
