#!/usr/bin/env node
/**
 * Deploy migrate runner — single Drizzle ledger (Option B).
 *
 * The ENTIRE schema is applied by ONE runner (drizzle-orm's `migrate()`) over
 * ONE ledger (drizzle.__drizzle_migrations), from apps/api/drizzle/:
 *
 *   0000_<generated>   declarative Drizzle tables (better-auth + metrics/pii/consent)
 *   0001_core          custom SQL — items / item_actions / action_events (LIST-partitioned)
 *   0002_item_search   custom SQL — item_search (vector + geography + hnsw/gist)
 *   NNNN_<version>     custom SQL — version-specific schema migrations, as needed
 *
 * Uses PROD-only deps (`drizzle-orm` + `pg`) — no `drizzle-kit` (a devDependency,
 * pruned from the production image). Runs in the app image at deploy time.
 *
 *   pnpm --filter api db:migrate:deploy   (or: node apps/api/scripts/migrate.mjs)
 *
 * Steps:
 *   1. Extension preflight — assert the extensions the schema needs (vector,
 *      postgis) exist. They are a PROVISIONING prerequisite (common-services /
 *      RDS master in deploy; docker-entrypoint-initdb.d locally), NOT created
 *      here — the app role is least-privilege. Fail loudly if missing.
 *   2. Auto-baseline (legacy cutover) — a DB built by the OLD psql/schema.sql
 *      path already has every table but NO ledger, so `migrate()` would re-run
 *      the CREATE TABLEs and crash on "relation already exists". When the ledger
 *      is empty AND a sentinel table (`items`) is present, seed the ledger with
 *      the migrations describing the already-present schema so they are skipped;
 *      only genuinely new migrations then run. Fresh DBs (no sentinel) skip this.
 *   3. migrate() — apply pending journal entries once, in order, transactionally.
 */
import { resolve, join } from 'node:path';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import {
  ledgerPopulated,
  tableExists,
  readJournalEntries,
  seedLedger,
} from './drizzle_baseline.mjs';
import { checkParity } from './parity.mjs';

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

const drizzleDir = join(resolve(import.meta.dirname, '..'), 'drizzle');

// Extensions the schema actually depends on (item_search.embedding / .geo).
// gen_random_uuid() is core in PG13+, so the rest of the schema needs none.
// common-services (RDS master) provisions the full set; we only assert the two
// the migrations would fail without.
const REQUIRED_EXTENSIONS = ['vector', 'postgis'];

async function assertExtensions(client) {
  const { rows } = await client.query('SELECT extname FROM pg_extension');
  const present = new Set(rows.map((r) => r.extname));
  const missing = REQUIRED_EXTENSIONS.filter((e) => !present.has(e));
  if (missing.length > 0) {
    throw new Error(
      `required Postgres extension(s) missing: ${missing.join(', ')}. ` +
        `Extensions are a provisioning prerequisite (common-services / RDS master ` +
        `in deploy; docker-entrypoint-initdb.d locally) and must exist before the ` +
        `migrate-Job runs. Aborting.`
    );
  }
}

async function main() {
  const masked = pgUrl.replace(/:[^:@/]+@/, ':***@');
  console.log(`db:migrate:deploy → ${masked}`);

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    // 1. Extension preflight (guards the extensions-removed-from-path ordering).
    console.log('[1/3] extension preflight');
    await assertExtensions(client);
    console.log(`  ok — ${REQUIRED_EXTENSIONS.join(', ')} present`);

    // 2. Auto-baseline a legacy DB (schema present, ledger empty).
    console.log('[2/3] baseline check');
    const populated = await ledgerPopulated(client);
    if (populated) {
      console.log('  ledger present → normal incremental migrate');
    } else if (await tableExists(client, 'public', 'items')) {
      // Legacy cutover: every current migration describes schema that already
      // exists. Baselining marks them "applied" WITHOUT running them, so it is
      // only truthful if the live schema actually matches the committed model.
      // Guard: parity-check the declarative tables first and ABORT on any
      // divergence, rather than silently adopting a drifted ("old sql") schema.
      console.log('  existing schema, no ledger → parity check before baseline (cutover)');
      const { problems, messages } = await checkParity(client, drizzleDir);
      messages.forEach((m) => console.log(`    ${m}`));
      if (problems > 0) {
        throw new Error(
          `check_parity: ${problems} divergence(s) between the live schema and the committed ` +
            `Drizzle model — refusing to baseline a drifted database (would mark migrations ` +
            `applied over a schema that does not match). Reconcile first: author a corrective ` +
            `migration for the delta, or bring the database to match the model. Aborting.`
        );
      }
      console.log('  parity OK → auto-baselining current migrations');
      const entries = await readJournalEntries(drizzleDir);
      const { seeded } = await seedLedger(client, drizzleDir, {
        entries,
        log: (m) => console.log(`  ${m}`),
      });
      console.log(`  baseline: marked ${seeded} migration(s) as already-applied`);
    } else {
      console.log('  fresh database → migrator will create everything');
    }
  } finally {
    await client.end();
  }

  // 3. One migrate() over one ledger — declarative tables + custom raw
  // migrations + version migrations, in journal order.
  console.log('[3/3] drizzle migrate()');
  const pool = new Pool({ connectionString: pgUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: drizzleDir });
    console.log('  ok');
  } finally {
    await pool.end();
  }

  console.log('db:migrate:deploy complete.');
}

main().catch((err) => {
  console.error('db:migrate:deploy failed:', err);
  process.exit(1);
});
