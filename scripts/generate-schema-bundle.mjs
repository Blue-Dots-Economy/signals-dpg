#!/usr/bin/env node
// scripts/generate-schema-bundle.mjs
//
// Assembles apps/api/db/postgres/schema.sql from the idempotent
// SQL scripts under packages/database/src/utils/sql_scripts/.
//
// Source order matters — tables referenced by FKs must exist before the
// tables that reference them. The list below is hand-curated and reviewed.
//
// Run: pnpm schema:bundle
// CI freshness check: pnpm schema:bundle:check

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sqlDir = join(repoRoot, 'packages/database/src/utils/sql_scripts');
const outPath = join(repoRoot, 'apps/api/db/postgres/schema.sql');

// FK-safe order. auth tables (referenced by items.created_by) must come first.
const FILES = [
  'auth.sql',                  // better-auth tables (Plan 4 Task A.2)
  'metrics.sql',               // participant_metrics (FKs to user + organization)
  'pii_reveal_audit.sql',      // PII-reveal audit log (no FKs — partitioned refs)
  'create_items.sql',          // items table + partitions
  'create_actions_events.sql', // item_actions + action_events
];

const BANNER = `-- GENERATED FILE — do not edit by hand.
--
-- Source: ${FILES.map((f) => 'packages/database/src/utils/sql_scripts/' + f).join(', ')}
-- Regenerate with: pnpm schema:bundle
-- CI guards drift via: pnpm schema:bundle:check
--
-- Applied by the deployment migrate-job at install/upgrade time (charts live
-- in a separate repo). Every statement must be idempotent (CREATE … IF NOT
-- EXISTS / ALTER … ADD COLUMN IF NOT EXISTS / DO-block-guarded ADD
-- CONSTRAINT). See docs/operations/migrations.md for the full contract.
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
