/**
 * Shared parity check: compare the live database's Drizzle-owned (declarative)
 * tables against the committed Drizzle snapshot (the model behind `0000`).
 *
 * Used by:
 *   - scripts/check_parity.mjs — standalone `db:check:parity` (prints + exits).
 *   - scripts/migrate.mjs      — a pre-baseline guard: before adopting an
 *                                existing (legacy) database by seeding the
 *                                ledger, verify the live schema actually matches
 *                                the model. If it does not, baselining would
 *                                mark migrations "applied" over a schema that
 *                                doesn't match — silently adopting drift. The
 *                                guard aborts loudly instead.
 *
 * Only the declarative tables are in the snapshot, so only those are checked
 * (the raw partitioned/geo tables are off the schema path). Missing tables,
 * missing columns, and NOT-NULL regressions are problems; extra columns are
 * informational.
 */
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function latestSnapshot(drizzleDir) {
  const metaDir = join(drizzleDir, 'meta');
  const files = (await readdir(metaDir)).filter((f) => f.endsWith('_snapshot.json')).sort();
  if (files.length === 0) throw new Error('no drizzle snapshot found');
  return JSON.parse(await readFile(join(metaDir, files[files.length - 1]), 'utf8'));
}

/**
 * @param {import('pg').Client} client  connected pg client
 * @param {string} drizzleDir           apps/api/drizzle
 * @returns {Promise<{ snapshotVersion: string, problems: number, messages: string[] }>}
 */
export async function checkParity(client, drizzleDir) {
  const snap = await latestSnapshot(drizzleDir);
  const messages = [];
  let problems = 0;

  for (const table of Object.values(snap.tables)) {
    const schema = table.schema || 'public';
    const name = table.name;
    const expected = Object.values(table.columns); // { name, type, notNull, ... }

    const { rows } = await client.query(
      'SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
      [schema, name]
    );
    if (rows.length === 0) {
      messages.push(`MISSING TABLE: ${schema}.${name}`);
      problems++;
      continue;
    }
    const actual = new Map(rows.map((r) => [r.column_name, r.is_nullable === 'NO']));

    for (const col of expected) {
      if (!actual.has(col.name)) {
        messages.push(`  ${name}: MISSING column "${col.name}" (${col.type})`);
        problems++;
      } else if (col.notNull === true && actual.get(col.name) !== true) {
        messages.push(`  ${name}: column "${col.name}" is nullable in DB but NOT NULL in model`);
        problems++;
      }
    }
    const expectedNames = new Set(expected.map((c) => c.name));
    for (const a of actual.keys()) {
      if (!expectedNames.has(a)) messages.push(`  ${name}: extra column "${a}" in DB (info)`);
    }
  }

  return { snapshotVersion: snap.version, problems, messages };
}
