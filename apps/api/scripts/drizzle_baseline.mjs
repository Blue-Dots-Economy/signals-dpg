/**
 * Shared baseline helpers: seed drizzle.__drizzle_migrations so migrate() skips
 * already-present schema (adopt a pre-existing DB without re-running its DDL).
 * Row format matches drizzle's migrator: (hash = sha256 of the .sql, created_at
 * = journal `when`); the migrator applies entries newer than the max created_at.
 * Used by migrate.mjs (auto cutover) and baseline.mjs (manual).
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** True if drizzle's ledger table exists AND has at least one row. */
export async function ledgerPopulated(client) {
  const reg = await client.query(`SELECT to_regclass('drizzle.__drizzle_migrations') AS t`);
  if (!reg.rows[0].t) return false;
  const { rows } = await client.query('SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations');
  return rows[0].n > 0;
}

/** True if a table exists (via information_schema, quoting-safe for reserved names). */
export async function tableExists(client, schema, name) {
  const { rows } = await client.query(
    'SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2 LIMIT 1',
    [schema, name]
  );
  return rows.length > 0;
}

/** Read + idx-sort the Drizzle journal entries. */
export async function readJournalEntries(drizzleDir) {
  const journal = JSON.parse(await readFile(join(drizzleDir, 'meta/_journal.json'), 'utf8'));
  return [...journal.entries].sort((a, b) => a.idx - b.idx);
}

/**
 * Seed the ledger for the given journal entries (default: all), creating the
 * drizzle schema/table as the connecting role. Idempotent. Returns { seeded, skipped }.
 * @param {{ entries?: any[], upTo?: string|null, dryRun?: boolean, log?: (m: string) => void }} [opts]
 */
export async function seedLedger(client, drizzleDir, opts = {}) {
  const { upTo = null, dryRun = false, log = () => {} } = opts;
  const list = opts.entries ?? (await readJournalEntries(drizzleDir));

  if (!dryRun) {
    await client.query('CREATE SCHEMA IF NOT EXISTS drizzle');
    await client.query(
      'CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)'
    );
  }

  let seeded = 0;
  let skipped = 0;
  for (const e of list) {
    const sql = await readFile(join(drizzleDir, `${e.tag}.sql`), 'utf8');
    const hash = createHash('sha256').update(sql).digest('hex');
    const existing = dryRun
      ? { rows: [] }
      : await client.query('SELECT 1 FROM drizzle.__drizzle_migrations WHERE created_at = $1', [e.when]);
    if (existing.rows.length > 0) {
      skipped++;
    } else {
      if (!dryRun) {
        await client.query('INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)', [
          hash,
          e.when,
        ]);
      }
      seeded++;
      log(`  baselined ${e.tag}${dryRun ? ' (dry-run)' : ''}`);
    }
    if (upTo && e.tag === upTo) break;
  }
  return { seeded, skipped };
}
