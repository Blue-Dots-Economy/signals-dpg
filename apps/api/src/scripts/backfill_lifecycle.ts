/**
 * backfill_lifecycle: recompute items.lifecycle_status for existing rows after
 * a network.json `required[]` change. Re-runs each item's stored state through
 * `classify_item` and updates only rows whose status changed.
 *
 * No `gates` are passed, so only the default `schema_required` gate applies:
 * `consent_accepted` is computed but has no effect, and the consent and
 * owner gates a domain may declare are not evaluated.
 *
 * No decryption is needed: the public `item_state` carries masks for provided
 * private fields, which count as populated, so completeness matches write time.
 *
 * On-demand and idempotent. Ships compiled in the api image:
 *   node dist/scripts/backfill_lifecycle.js [--network N] [--domain D] [--item-type T] [--dry-run]
 *   (local: pnpm --filter api db:backfill:lifecycle -- --dry-run)
 */
import { and, eq, asc, sql, type SQL } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { classify_item, type LifecycleStatus } from '@/services/items/classifier';
import { get_item_schema, type JSONSchemaLike } from '@/services/metrics/schema_lookup';

const BATCH_SIZE = 1000;

interface Args {
  network?: string;
  domain?: string;
  itemType?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--network': a.network = argv[++i]; break;
      case '--domain': a.domain = argv[++i]; break;
      case '--item-type': a.itemType = argv[++i]; break;
      case '--dry-run': a.dryRun = true; break;
      case '--': break; // arg separator forwarded by pnpm/npm
      default: throw new Error(`unknown arg: ${argv[i]}`);
    }
  }
  return a;
}

// Per network/domain/item_type. Null means unresolvable (unserved or removed);
// those items are skipped.
const schemaCache = new Map<string, JSONSchemaLike | null>();
async function schemaFor(network: string, domain: string, itemType: string): Promise<JSONSchemaLike | null> {
  const key = `${network}/${domain}/${itemType}`;
  if (schemaCache.has(key)) return schemaCache.get(key)!;
  let schema: JSONSchemaLike | null = null;
  try {
    schema = await get_item_schema(network, domain, itemType);
  } catch {
    schema = null;
  }
  schemaCache.set(key, schema);
  return schema;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(
    `backfill_lifecycle: scope=${args.network ?? '*'}/${args.domain ?? '*'}/${args.itemType ?? '*'}` +
      `${args.dryRun ? ' (dry-run)' : ''}`,
  );

  const scope: Array<SQL | undefined> = [
    args.network ? eq(items.item_network, args.network) : undefined,
    args.domain ? eq(items.item_domain, args.domain) : undefined,
    args.itemType ? eq(items.item_type, args.itemType) : undefined,
  ];

  let scanned = 0;
  let changed = 0;
  let skipped = 0;
  const transitions: Record<string, number> = {};

  // Items with a `profile_creation` row in the consent ledger.
  const consentedResult = await db.execute(
    sql`SELECT DISTINCT item_id FROM consent_record
        WHERE level = 'item' AND consent_category = 'profile_creation' AND item_id IS NOT NULL`
  );
  const consented = new Set(
    ((consentedResult as unknown as { rows: Array<{ item_id: string }> }).rows ?? []).map(
      (r) => r.item_id
    )
  );

  // Offset pagination is stable: only lifecycle_status is updated, never the
  // ORDER BY keys (the composite PK).
  const whereScope = and(...scope);
  for (let offset = 0; ; offset += BATCH_SIZE) {
    const rows = await db
      .select({
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_id: items.item_id,
        item_state: items.item_state,
        lifecycle_status: items.lifecycle_status,
      })
      .from(items)
      .where(whereScope)
      .orderBy(asc(items.item_network), asc(items.item_domain), asc(items.item_type), asc(items.item_id))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (rows.length === 0) break;

    for (const row of rows) {
      scanned++;
      const schema = await schemaFor(row.item_network, row.item_domain, row.item_type);
      if (!schema) {
        skipped++;
        continue;
      }
      const current = row.lifecycle_status as LifecycleStatus;
      // No `gates`: a backfill must not demote a population for want of an
      // owning aggregator (`owner_required`).
      const next = classify_item({
        schema,
        merged_state: (row.item_state ?? {}) as Record<string, unknown>,
        current_status: current,
        consent_accepted: consented.has(row.item_id),
      }).lifecycle_status;

      if (next !== current) {
        transitions[`${current}->${next}`] = (transitions[`${current}->${next}`] ?? 0) + 1;
        changed++;
        if (!args.dryRun) {
          await db
            .update(items)
            .set({ lifecycle_status: next })
            .where(
              and(
                eq(items.item_network, row.item_network),
                eq(items.item_domain, row.item_domain),
                eq(items.item_type, row.item_type),
                eq(items.item_id, row.item_id),
              ),
            );
        }
      }
    }

    if (rows.length < BATCH_SIZE) break;
  }

  console.log(
    `backfill_lifecycle: scanned=${scanned} changed=${changed} skipped=${skipped}` +
      `${args.dryRun ? ' (dry-run — no writes)' : ''}`,
  );
  for (const [k, v] of Object.entries(transitions)) console.log(`  ${k}: ${v}`);
  console.log('backfill_lifecycle: done.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('backfill_lifecycle failed:', err);
    process.exit(1);
  });
