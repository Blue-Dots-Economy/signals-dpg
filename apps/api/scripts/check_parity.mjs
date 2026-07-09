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
 * Exit 0 = safe to baseline; exit 1 = divergence found.
 *
 *   node apps/api/scripts/check_parity.mjs
 */
import { readFile, readdir } from 'node:fs/promises';
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

async function latestSnapshot() {
  const files = (await readdir(join(drizzleDir, 'meta')))
    .filter((f) => f.endsWith('_snapshot.json'))
    .sort();
  if (files.length === 0) throw new Error('no drizzle snapshot found');
  return JSON.parse(await readFile(join(drizzleDir, 'meta', files[files.length - 1]), 'utf8'));
}

async function main() {
  const snap = await latestSnapshot();
  console.log(`check_parity → ${pgUrl.replace(/:[^:@/]+@/, ':***@')} (snapshot v${snap.version})`);

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  let problems = 0;
  try {
    for (const table of Object.values(snap.tables)) {
      const schema = table.schema || 'public';
      const name = table.name;
      const expected = Object.values(table.columns); // { name, type, notNull, ... }

      const { rows } = await client.query(
        `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2`,
        [schema, name]
      );
      if (rows.length === 0) {
        console.log(`MISSING TABLE: ${schema}.${name}`);
        problems++;
        continue;
      }
      const actual = new Map(rows.map((r) => [r.column_name, r.is_nullable === 'NO']));

      for (const col of expected) {
        if (!actual.has(col.name)) {
          console.log(`  ${name}: MISSING column "${col.name}" (${col.type})`);
          problems++;
        } else if (col.notNull === true && actual.get(col.name) !== true) {
          console.log(`  ${name}: column "${col.name}" is nullable in DB but NOT NULL in model`);
          problems++;
        }
      }
      const expectedNames = new Set(expected.map((c) => c.name));
      for (const a of actual.keys()) {
        if (!expectedNames.has(a)) console.log(`  ${name}: extra column "${a}" in DB (info)`);
      }
    }
  } finally {
    await client.end();
  }

  if (problems > 0) {
    console.error(`check_parity: ${problems} divergence(s) — NOT safe to baseline. Reconcile first.`);
    process.exit(1);
  }
  console.log('check_parity: OK — live schema matches the Drizzle model; safe to baseline.');
}

main().catch((err) => {
  console.error('check_parity failed:', err);
  process.exit(1);
});
