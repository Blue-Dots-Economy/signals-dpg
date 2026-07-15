#!/usr/bin/env node
/**
 * Deploy migrate runner (Direction B).
 *
 * Applies the full database schema in dependency order using PROD-only deps
 * (`drizzle-orm` + `pg`) — no `drizzle-kit` (a devDependency, pruned from the
 * production image). Order:
 *
 *   1. extensions        — extensions/extensions.sql (pgcrypto/cube/earthdistance/vector/postgis)
 *   2. drizzle migrations — apps/api/drizzle/ (better-auth + item_metrics/pii_reveal_audit/consent_record)
 *                          Auto-baselines the INITIAL migration when it detects an
 *                          existing schema with no ledger (hands-off cutover from
 *                          the old psql/schema.sql path — see below).
 *   3. core (raw)        — core/create_items.sql, core/create_actions_events.sql
 *                          (partitioned; items.created_by FKs to the Drizzle-owned "user")
 *   4. version migrations — migrations/NNNN_*.sql (ordered ALTER/backfill)
 *
 * Idempotent — safe to re-run. Runs in the app image at deploy time.
 *
 * Auto-baseline (cutover safety): a database built by the OLD path already has
 * the Drizzle-owned tables but NO ledger, so a naive migrate() would try to
 * CREATE them and fail with "relation already exists". Before migrating, this
 * script checks for that state (a sentinel Drizzle table present, ledger empty)
 * and seeds ONLY the initial migration into the ledger — the full-schema
 * snapshot the sentinel confirms. Any LATER delta migrations are still applied
 * normally, never skipped: if a delta genuinely does not fit the live schema it
 * fails loudly (the correct outcome for an unattended job) rather than silently
 * dropping a change. For a DB that is ahead of the initial snapshot, run the
 * human-driven `db:check:parity` + `db:baseline --up-to <tag>` instead.
 *
 * Run: pnpm --filter api db:migrate:deploy   (or: node apps/api/scripts/migrate.mjs)
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  ledgerPopulated,
  tableExists,
  readJournalEntries,
  seedLedger,
} from './drizzle_baseline.mjs';

// dotenv is only useful for local runs; in deploy the pod already has env vars.
try {
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: resolve(import.meta.dirname, '../../../.env') });
} catch {
  /* no dotenv (e.g. minimal deploy image) — rely on the process env */
}

const { Client, Pool } = pg;

const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const apiRoot = resolve(import.meta.dirname, '..'); // apps/api
const drizzleDir = join(apiRoot, 'drizzle');
const sqlDir = resolve(
  import.meta.dirname,
  '../../../packages/database/src/utils/sql_scripts'
);

async function applyRawFile(client, relPath) {
  const abs = join(sqlDir, relPath);
  process.stdout.write(`  applying ${relPath}... `);
  const sql = await readFile(abs, 'utf8');
  await client.query(sql);
  console.log('ok');
}

async function main() {
  const masked = pgUrl.replace(/:[^:@/]+@/, ':***@');
  console.log(`db:migrate:deploy → ${masked}`);

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    // 1. Extensions first — the raw item/search tables use vector/geo types,
    // and gen_random_uuid() defaults are safest with pgcrypto present. In deploy
    // these already exist (common-services); CREATE EXTENSION IF NOT EXISTS is a no-op.
    console.log('[1/4] extensions');
    await applyRawFile(client, 'extensions/extensions.sql');
  } finally {
    await client.end();
  }

  // 2. Drizzle-owned tables (better-auth + metrics/pii/consent) via the
  // runtime migrator over the committed apps/api/drizzle/ migration files.
  console.log('[2/4] drizzle migrations');

  // 2a. Auto-baseline: adopt an existing pre-Direction-B DB (schema present, no
  // ledger) by seeding ONLY the initial migration, so migrate() skips it
  // instead of CREATE-ing tables that already exist. "user" is the sentinel —
  // it (and the rest of the Drizzle-owned set) shipped in the old schema.sql
  // bundle, so its presence means the initial snapshot is already there.
  const baselineClient = new Client({ connectionString: pgUrl });
  await baselineClient.connect();
  try {
    const populated = await ledgerPopulated(baselineClient);
    if (populated) {
      console.log('  ledger present → normal incremental migrate');
    } else if (await tableExists(baselineClient, 'public', 'user')) {
      console.log(
        '  existing schema, no ledger → auto-baselining the initial migration (cutover)'
      );
      const entries = await readJournalEntries(drizzleDir);
      const initial = entries.slice(0, 1); // initial snapshot only; deltas still apply below
      const { seeded } = await seedLedger(baselineClient, drizzleDir, {
        entries: initial,
        log: (m) => console.log(`  ${m}`),
      });
      console.log(`  baseline: marked ${seeded} initial migration(s) as already-applied`);
    } else {
      console.log('  fresh database → migrator will create all tables');
    }
  } finally {
    await baselineClient.end();
  }

  const pool = new Pool({ connectionString: pgUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: drizzleDir });
    console.log('  ok');
  } finally {
    await pool.end();
  }

  const client2 = new Client({ connectionString: pgUrl });
  await client2.connect();
  try {
    // 3. Raw core tables (FK to the now-existing "user").
    console.log('[3/4] core (items/actions/events)');
    await applyRawFile(client2, 'core/create_items.sql');
    await applyRawFile(client2, 'core/create_actions_events.sql');

    // 4. Ordered version migrations (ALTER/backfill for existing DBs).
    console.log('[4/4] version migrations');
    const migDir = join(sqlDir, 'migrations');
    const migs = (await readdir(migDir))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const m of migs) {
      await applyRawFile(client2, join('migrations', m));
    }
  } finally {
    await client2.end();
  }

  console.log('db:migrate:deploy complete.');
}

main().catch((err) => {
  console.error('db:migrate:deploy failed:', err);
  process.exit(1);
});
