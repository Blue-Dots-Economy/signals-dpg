/**
 * Apply the idempotent SQL bootstrap files that aren't managed by Drizzle.
 *
 * The auth tables (user, account, organization, etc.) live in
 * apps/api/db/postgres/schema/ and are pushed by drizzle-kit
 * (`pnpm db:push:api`). The partitioned `items`, `item_actions` and
 * `action_events` tables (with extensions + GIN/GiST indexes) are raw
 * idempotent SQL under packages/database/src/utils/sql_scripts/, applied only
 * by this script; without it a fresh clone hits `PARTITION_SETUP_FAILED` on
 * the first item create.
 *
 * Run from repo root: pnpm db:init:api
 * Run inside apps/api: pnpm db:init
 *
 * Idempotent — safe to re-run.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client } from 'pg';
import dotenv from 'dotenv';

dotenv.config({ path: '../../.env' });

const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const sqlDir = resolve(
  import.meta.dirname,
  '../../../packages/database/src/utils/sql_scripts'
);

// Applies the raw (non-Drizzle) layer for local dev: extensions first (the
// item/search tables use vector/geo types), then the partitioned core tables.
// Order matters: items must exist before any code-side ensureItemPartition()
// call hits it; same for actions/events.
//
// The auth / item_metrics / pii_reveal_audit / consent_record tables are owned
// by Drizzle (`pnpm db:push:api` locally, apps/api/drizzle/ migrations via
// scripts/migrate.mjs in deploy), so they are not in this list.
const FILES = [
  'extensions/extensions.sql',
  'core/create_items.sql',
  'core/create_actions_events.sql',
];

const main = async () => {
  const maskedUrl = pgUrl.replace(/:[^:@/]+@/, ':***@');
  console.log(`db_init → ${maskedUrl}`);

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    for (const f of FILES) {
      process.stdout.write(`  applying ${f}... `);
      const sql = await readFile(resolve(sqlDir, f), 'utf8');
      await client.query(sql);
      console.log('ok');
    }
    console.log('db_init complete.');
  } finally {
    await client.end();
  }
};

main().catch((err) => {
  console.error('db_init failed:', err);
  process.exit(1);
});
