/**
 * One-time backfill: classify pre-existing items rows whose lifecycle_status
 * is still the default 'draft' AND completion_pct is still 0 — i.e. rows
 * that pre-date the lifecycle migration (spec §15). Idempotent on re-run.
 *
 * Usage: tsx apps/api/scripts/backfill_item_lifecycle.ts
 */
import { and, eq, sql } from 'drizzle-orm';
import { db } from '../db/postgres/drizzle_config.js';
import { items } from '@dpg/database';
import { classify_item } from '../src/services/items/classifier.js';
import { getOrFetchSchemaByUrl } from '../src/network_schema_cache.js';
import { decryptItemPrivate } from '../src/utils/item_decrypt.js';

async function main() {
  const rows = await db
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

  let updated = 0;
  for (const row of rows) {
    let schemaDoc: Record<string, unknown> | null = null;
    try {
      schemaDoc = await getOrFetchSchemaByUrl({
        schemaUrl: row.item_schema_url,
        network: row.item_network,
        domain: row.item_domain,
        itemType: row.item_type,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `skipping ${row.item_id}: schema fetch failed (${(err as Error).message})`,
      );
      continue;
    }
    const { mergedState } = decryptItemPrivate({
      item_state: row.item_state as Record<string, unknown>,
      item_private_state: row.item_private_state ?? '',
    });
    const c = classify_item({
      schema: schemaDoc as { required?: string[] },
      merged_state: mergedState,
      current_status: 'draft',
    });
    await db
      .update(items)
      .set({
        lifecycle_status: c.lifecycle_status,
        completion_pct: c.completion_pct,
        updated_at: sql`now()`,
      })
      .where(eq(items.item_id, row.item_id));
    updated += 1;
  }
  // eslint-disable-next-line no-console
  console.log(`backfill complete: ${updated} rows updated`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('backfill failed:', err);
    process.exit(1);
  });
