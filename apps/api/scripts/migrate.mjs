#!/usr/bin/env node
/**
 * Deploy migrate runner: applies the whole schema via one drizzle-orm migrate()
 * over one ledger (apps/api/drizzle/). Prod-only deps (no drizzle-kit).
 * Steps: extension preflight → auto-baseline legacy DBs → migrate().
 * Run: pnpm --filter api db:migrate:deploy
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

// dotenv for local runs; in deploy the pod env is already set.
try {
  const dotenv = (await import('dotenv')).default;
  dotenv.config({ path: resolve(import.meta.dirname, '../../../.env') });
} catch {
  /* no dotenv — rely on process env */
}

const { Client, Pool } = pg;

const pgUrl =
  process.env.POSTGRES_URL ??
  `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

const drizzleDir = join(resolve(import.meta.dirname, '..'), 'drizzle');

// Extensions item_search needs; provisioned upstream (common-services), asserted here.
const REQUIRED_EXTENSIONS = ['vector', 'postgis'];

async function assertExtensions(client) {
  const { rows } = await client.query('SELECT extname FROM pg_extension');
  const present = new Set(rows.map((r) => r.extname));
  const missing = REQUIRED_EXTENSIONS.filter((e) => !present.has(e));
  if (missing.length > 0) {
    throw new Error(
      `required Postgres extension(s) missing: ${missing.join(', ')} — must be provisioned before migrate. Aborting.`
    );
  }
}

async function main() {
  const masked = pgUrl.replace(/:[^:@/]+@/, ':***@');
  console.log(`db:migrate:deploy → ${masked}`);

  const client = new Client({ connectionString: pgUrl });
  await client.connect();
  try {
    // 1. Extensions must be provisioned before migrate; fail loudly if not.
    console.log('[1/3] extension preflight');
    await assertExtensions(client);
    console.log(`  ok — ${REQUIRED_EXTENSIONS.join(', ')} present`);

    // 2. Legacy cutover: seed the ledger so migrate() skips already-present schema.
    console.log('[2/3] baseline check');
    const populated = await ledgerPopulated(client);
    if (populated) {
      console.log('  ledger present → normal incremental migrate');
    } else if (await tableExists(client, 'public', 'items')) {
      // Baseline only if the live schema matches the model — else abort, don't adopt drift.
      console.log('  existing schema, no ledger → parity check before baseline (cutover)');
      const { problems, messages } = await checkParity(client, drizzleDir);
      messages.forEach((m) => console.log(`    ${m}`));
      if (problems > 0) {
        throw new Error(
          `check_parity: ${problems} divergence(s) — refusing to baseline a drifted database. Reconcile first. Aborting.`
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

  // 3. Apply pending migrations in journal order, once each.
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
