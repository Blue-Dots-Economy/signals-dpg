/**
 * One-off backfill (#439): populate item_actions.match_score for existing OPEN
 * (non-terminal) actions where both endpoints resolve to local, live items.
 * Idempotent — only touches rows where match_score is still null, so it's safe
 * to re-run. Run once after the #439 migration:
 *   pnpm --filter api exec tsx scripts/backfill_action_match_scores.ts
 */
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { item_actions, items } from '@dpg/database';
import { computeActionMatchScore } from '@/services/actions/compute_match_score';
import { terminalStatuses } from '@/services/action_pair_cap';
import { getNetworkConfigById } from '@/network_configs';

// computeActionMatchScore only needs a `warn` method — console satisfies that shape.
const scriptLog = {
  warn: (...args: unknown[]) => {
    // eslint-disable-next-line no-console
    console.warn(...args);
  },
};

// terminalStatuses() is network-config-driven (varies per network), so cache
// per partition_network instead of refetching config for every row.
const terminalStatusCache = new Map<string, string[]>();

async function getTerminalStatusesFor(network: string): Promise<string[]> {
  const cached = terminalStatusCache.get(network);
  if (cached) return cached;
  const cfg = await getNetworkConfigById(network);
  const terminal = terminalStatuses(cfg);
  terminalStatusCache.set(network, terminal);
  return terminal;
}

// Columns needed to build a MatchScoreItem via computeActionMatchScore's
// ItemSnapshotLike shape, plus lifecycle_status to gate on "live".
const itemColumns = {
  item_network: items.item_network,
  item_domain: items.item_domain,
  item_type: items.item_type,
  item_id: items.item_id,
  item_instance_url: items.item_instance_url,
  item_schema_url: items.item_schema_url,
  item_state: items.item_state,
  item_locations: items.item_locations,
  lifecycle_status: items.lifecycle_status,
};

async function main(): Promise<void> {
  const rows = await db.select().from(item_actions).where(isNull(item_actions.match_score));

  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const terminal = await getTerminalStatusesFor(row.partition_network);
    if (terminal.includes(row.action_status)) {
      skipped++;
      continue;
    }

    const [src] = await db
      .select(itemColumns)
      .from(items)
      .where(
        and(
          eq(items.item_network, row.source_item_network),
          eq(items.item_domain, row.source_item_domain),
          eq(items.item_type, row.source_item_type),
          eq(items.item_id, row.source_item_id),
        ),
      );
    const [tgt] = await db
      .select(itemColumns)
      .from(items)
      .where(
        and(
          eq(items.item_network, row.target_item_network),
          eq(items.item_domain, row.target_item_domain),
          eq(items.item_type, row.target_item_type),
          eq(items.item_id, row.target_item_id),
        ),
      );

    if (!src || !tgt || src.lifecycle_status !== 'live' || tgt.lifecycle_status !== 'live') {
      skipped++;
      continue;
    }

    const score = await computeActionMatchScore(src, tgt, scriptLog);
    if (score === null) {
      skipped++;
      continue;
    }

    await db
      .update(item_actions)
      .set({ match_score: score })
      .where(
        and(
          eq(item_actions.partition_network, row.partition_network),
          eq(item_actions.action_type, row.action_type),
          eq(item_actions.action_id, row.action_id),
        ),
      );
    updated++;
  }

  // eslint-disable-next-line no-console
  console.log(`backfill: updated ${updated}/${rows.length} action match scores (${skipped} skipped)`);
  process.exit(0);
}

void main();
