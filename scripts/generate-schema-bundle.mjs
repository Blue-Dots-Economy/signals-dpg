#!/usr/bin/env node
// scripts/generate-schema-bundle.mjs
//
// Assembles apps/api/db/postgres/schema.sql from the idempotent SQL scripts
// under packages/database/src/utils/sql_scripts/ that are NOT managed by
// Drizzle — i.e. the Postgres-native layer (extensions + the partitioned
// item/action/event tables with vector/geo types). The better-auth /
// item_metrics / pii_reveal_audit / consent_record tables are owned by Drizzle
// (apps/api/db/postgres/schema/*.ts) and applied via `drizzle-orm` migrations
// (apps/api/drizzle/), NOT bundled here.
//
// This bundle is for LOCAL dev only (applied by `pnpm db:init:api` /
// apps/api/scripts/db_init.ts). The DEPLOY path does NOT use it — the
// migrate runner (apps/api/scripts/migrate.mjs) applies one Drizzle ledger
// over apps/api/drizzle/ (the raw core tables live there as custom migrations).
//
// Source order matters — extensions first, then the core tables.
//
// Run: pnpm schema:bundle
// CI freshness check: pnpm schema:bundle:check

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sqlDir = join(repoRoot, 'packages/database/src/utils/sql_scripts');
const outPath = join(repoRoot, 'apps/api/db/postgres/schema.sql');

// Raw (non-Drizzle) layer, in FK-safe order. Extensions first (the item/search
// tables use vector/geo types); then the partitioned core tables. The Drizzle-
// owned "user" table these FK to is created earlier by the drizzle migrations.
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
