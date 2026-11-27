#!/usr/bin/env node
// Assembles apps/api/db/postgres/schema.sql from the idempotent raw SQL scripts
// under packages/database/src/utils/sql_scripts/: extensions plus the
// partitioned item/action/event tables. Tables defined in
// apps/api/db/postgres/schema/*.ts are owned by Drizzle and not bundled.
//
// The bundle is a generated reference copy applied by CI's test and schema-parity jobs.
// Nothing at runtime applies it: `pnpm db:init:api` reads the source scripts
// directly, and deploys run the Drizzle ledger (apps/api/scripts/migrate.mjs).
//
// Run: pnpm schema:bundle
// CI freshness check: pnpm schema:bundle:check

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sqlDir = join(repoRoot, 'packages/database/src/utils/sql_scripts');
const outPath = join(repoRoot, 'apps/api/db/postgres/schema.sql');

// FK-safe order: extensions first (the tables use vector/geo types), then the
// core tables. The Drizzle-owned "user" table they reference must exist first.
const FILES = [
  'extensions/extensions.sql',      // pgcrypto, cube, earthdistance, vector, postgis
  'core/create_items.sql',          // items (partitioned) + item_search
  'core/create_actions_events.sql', // item_actions + action_events (partitioned)
];

const BANNER = `-- GENERATED FILE — do not edit by hand.
--
-- Source: ${FILES.map((f) => 'packages/database/src/utils/sql_scripts/' + f).join(', ')}
-- Regenerate with: pnpm schema:bundle
-- CI guards drift via: pnpm schema:bundle:check
--
-- This is the RAW (non-Drizzle) layer: Postgres extensions + the partitioned
-- item/action/event tables. It is applied AFTER the Drizzle migrations
-- (apps/api/drizzle/) — items.created_by FKs to the Drizzle-owned "user" table.
-- Applied by the deploy migrate runner (apps/api/scripts/migrate.mjs). Every
-- statement must be idempotent (CREATE … IF NOT EXISTS / ALTER … ADD COLUMN IF
-- NOT EXISTS / DO-block-guarded ADD CONSTRAINT). See docs/operations/migrations.md.
`;

async function main() {
  const parts = [BANNER];
  for (const f of FILES) {
    const content = await readFile(join(sqlDir, f), 'utf8');
    parts.push(`-- ─── ${f} ───`);
    parts.push(content.trim());
  }
  const bundle = parts.join('\n\n') + '\n';
  await writeFile(outPath, bundle, 'utf8');
  console.log(`wrote ${outPath} (${bundle.length} bytes, ${FILES.length} sources)`);
}

main().catch((err) => {
  console.error('schema:bundle failed:', err);
  process.exit(1);
});
