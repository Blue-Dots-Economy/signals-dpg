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
 *   3. core (raw)        — core/create_items.sql, core/create_actions_events.sql
 *                          (partitioned; items.created_by FKs to the Drizzle-owned "user")
 *   4. version migrations — migrations/NNNN_*.sql (ordered ALTER/backfill)
 *
 * Idempotent — safe to re-run. Runs in the app image at deploy time.
 *
 * Run: pnpm --filter api db:migrate:deploy   (or: node apps/api/scripts/migrate.mjs)
 */
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

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
