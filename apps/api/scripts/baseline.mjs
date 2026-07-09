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
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import pg from 'pg';

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
  const journal = JSON.parse(await readFile(join(drizzleDir, 'meta/_journal.json'), 'utf8'));
  const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
  console.log(`baseline → ${pgUrl.replace(/:[^:@/]+@/, ':***@')}${dryRun ? ' (dry-run)' : ''}`);

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    if (!dryRun) {
      // Created by the connecting (app) role → owned by it. The migrator can
      // then read/write drizzle.__drizzle_migrations without a grant.
      await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
      await client.query(
        'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)'
      );
    }

    let seeded = 0;
    let skipped = 0;
    for (const e of entries) {
      const sql = await readFile(join(drizzleDir, `${e.tag}.sql`), 'utf8');
      const hash = createHash('sha256').update(sql).digest('hex');
      const existing = dryRun
        ? { rows: [] }
        : await client.query('SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = $1', [e.when]);
      if (existing.rows.length > 0) {
        skipped++;
      } else {
        if (!dryRun) {
          await client.query(
            'INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)',
            [hash, e.when]
          );
        }
        seeded++;
        console.log(`  baselined ${e.tag}${dryRun ? ' (dry-run)' : ''}`);
      }
      if (upTo && e.tag === upTo) break;
    }
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
