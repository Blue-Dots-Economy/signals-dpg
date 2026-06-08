/**
 * Backfill script — participant onboarding lifecycle (§15 of spec).
 *
 * Selects every item where lifecycle_status = 'draft' AND completion_pct = 0
 * (the column defaults; rows predating Task 1 never ran through classify_item).
 * For each matching row it:
 *   1. loads the item schema via getOrFetchSchemaByUrl (network_schema_cache)
 *   2. decrypts the merged state via decryptItemPrivate
 *   3. runs classify_item
 *   4. UPDATEs lifecycle_status + completion_pct in place
 *
 * Idempotent — the WHERE guard means re-runs skip already-classified rows.
 * A row that was legitimately seeded as draft+0 (empty state, no schema
 * required fields filled) remains at draft+0, which is correct.
 *
 * Usage:
 *   pnpm --filter api backfill:lifecycle
 *
 * Env vars: same as all other scripts — POSTGRES_URL or the individual
 * POSTGRES_USER / POSTGRES_PASSWORD / POSTGRES_HOST / POSTGRES_PORT /
 * POSTGRES_DB vars (see packages/config/src/secrets.ts).
 */

import { eq, and, sql } from 'drizzle-orm';

// NOTE: All modules that transitively import @api/db/postgres/drizzle_config
// (e.g. network_schema_cache, item_decrypt, classifier) must be imported
// DYNAMICALLY inside main(), AFTER tsx's --env-file flag has already loaded
// the environment.  A static import here would cause drizzle_config → config.ts
// → loadEnv() to Zod-parse process.env BEFORE the .env file is read, producing
// a ZodError at module evaluation time.  The package.json script passes
// --env-file=../../.env to tsx so the env is available from the very first
// statement; the dynamic imports below are a second layer of defence.

async function main() {
  // Dynamic imports ensure the modules evaluate only after tsx has injected
  // the env vars from --env-file.
  const { Pool } = await import('pg');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { SchemaFetchError } = await import('@dpg/schemas');
  const { items } = await import('@dpg/database');
  const { getOrFetchSchemaByUrl } = await import('../src/network_schema_cache.js');
  const { decryptItemPrivate } = await import('../src/utils/item_decrypt.js');
  const { classify_item } = await import('../src/services/items/classifier.js');

  const pgUrl =
    process.env.POSTGRES_URL ??
    `postgres://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@${process.env.POSTGRES_HOST ?? '127.0.0.1'}:${process.env.POSTGRES_PORT ?? process.env.DATABASE_PORT ?? '5432'}/${process.env.POSTGRES_DB}`;

  const pool = new Pool({ connectionString: pgUrl, ssl: false });
  const db = drizzle(pool);

  // Select only stale rows — the WHERE guard makes re-runs safe.
  const staleRows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_schema_url: items.item_schema_url,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
    })
    .from(items)
    .where(
      and(
        eq(items.lifecycle_status, 'draft'),
        eq(items.completion_pct, 0),
      ),
    );

  // eslint-disable-next-line no-console
  console.log(`[backfill:lifecycle] found ${staleRows.length} stale item(s) to classify`);

  let updated = 0;
  let skipped = 0;

  for (const row of staleRows) {
    let itemSchema: Record<string, unknown> | null = null;

    try {
      itemSchema = await getOrFetchSchemaByUrl({
        schemaUrl: row.item_schema_url,
        network: row.item_network,
        domain: row.item_domain,
        itemType: row.item_type,
      });
    } catch (err) {
      if (err instanceof SchemaFetchError) {
        // eslint-disable-next-line no-console
        console.warn(
          `[backfill:lifecycle] SKIP item=${row.item_id} — schema fetch failed: ${String(err.message)}`,
        );
        skipped++;
        continue;
      }
      throw err;
    }

    const { mergedState } = decryptItemPrivate({
      item_state: row.item_state as Record<string, unknown>,
      item_private_state: row.item_private_state ?? '',
    });

    const classification = classify_item({
      schema: itemSchema as { required?: string[] },
      merged_state: mergedState,
      current_status: 'draft',
    });

    // Only write when the classifier produces a non-zero result.  A truly
    // empty item (no required fields satisfied) will re-classify as draft+0
    // which is indistinguishable from the stale default — skip the UPDATE to
    // avoid unnecessary I/O and keep the idempotency guarantee tight.
    if (
      classification.lifecycle_status === 'draft' &&
      classification.completion_pct === 0
    ) {
      skipped++;
      continue;
    }

    await db
      .update(items)
      .set({
        lifecycle_status: classification.lifecycle_status,
        completion_pct: classification.completion_pct,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(items.item_id, row.item_id),
          eq(items.lifecycle_status, 'draft'),
          eq(items.completion_pct, 0),
        ),
      );

    updated++;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[backfill:lifecycle] done — updated=${updated}, skipped=${skipped} (schema errors or already-draft-0)`,
  );

  await pool.end();
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('[backfill:lifecycle] failed:', err);
    process.exit(1);
  });
