import { and, eq, or, sql } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import { getActionInteraction } from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import type { DbOrTx } from '@/services/item_service';

type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

/**
 * Fallback cancel status for interactions the network does not track
 * (`metric_categories` null / no `cancel` bucket). Matches the conventional
 * `cancel` value used by tracked interactions.
 */
const DEFAULT_CANCEL_STATUS = 'cancelled';

/**
 * System remark stamped on a connection cancelled by retire, so the counterparty
 * sees why it ended (their explicit reject/cancel would carry the user's own
 * remark). Neutral — doesn't announce that the owner retired. Only set when the
 * action has no existing remark.
 */
const RETIRE_CANCEL_REMARK = 'This profile is retired and no longer available.';

/**
 * Cancel every still-open connection referencing an item being retired (#347,
 * R9.3). "Open" = any action (as source OR target) whose status is not already
 * terminal (not in the interaction's `reject` ∪ `cancel` categories). Each such
 * action is flipped to the interaction's first `cancel` status.
 *
 * The action ROWS are kept (only the status changes) so the counterparty
 * retains their history with the bare id (Q11). Counterparties are NOT notified
 * (Q12 — deferred). Untracked interactions (no `metric_categories`, or no
 * `cancel` status defined) are skipped — there is no defined cancel status to
 * move them to.
 *
 * Runs inside the retire transaction (`tx`). Returns the number of actions
 * cancelled (for logging/telemetry).
 */
export async function cancelItemConnections(
  tx: DbOrTx,
  item: { item_id: string; item_network: string; item_domain: string; item_type: string },
  logger?: WarnLogger,
): Promise<number> {
  // Match on the full item ref on each side so the query can use the
  // source/target composite indexes (which lead with the item network) instead
  // of scanning by id alone. NOTE: this does NOT prune partitions — item_actions
  // is partitioned by `partition_network`, which isn't filtered here (a source-
  // side action can live in a different network's partition), so this is an
  // all-partition index scan, not a single-partition read. Correctness is fine.
  const asSource = and(
    eq(item_actions.source_item_network, item.item_network),
    eq(item_actions.source_item_domain, item.item_domain),
    eq(item_actions.source_item_type, item.item_type),
    eq(item_actions.source_item_id, item.item_id),
  );
  const asTarget = and(
    eq(item_actions.target_item_network, item.item_network),
    eq(item_actions.target_item_domain, item.item_domain),
    eq(item_actions.target_item_type, item.item_type),
    eq(item_actions.target_item_id, item.item_id),
  );
  const actions = await tx
    .select({
      partition_network: item_actions.partition_network,
      action_type: item_actions.action_type,
      action_id: item_actions.action_id,
      action_status: item_actions.action_status,
      remarks: item_actions.remarks,
      source_item_network: item_actions.source_item_network,
      source_item_domain: item_actions.source_item_domain,
      source_item_type: item_actions.source_item_type,
      target_item_network: item_actions.target_item_network,
      target_item_domain: item_actions.target_item_domain,
      target_item_type: item_actions.target_item_type,
    })
    .from(item_actions)
    .where(or(asSource, asTarget));

  let cancelled = 0;
  for (const a of actions) {
    // Resolve the interaction to read its cancel/terminal buckets. If it's no
    // longer defined in config, fall through with no categories — retire still
    // cancels via the fallback below rather than leaving the action dangling.
    let interaction: ReturnType<typeof getActionInteraction> | null = null;
    try {
      const networkConfig = await getNetworkConfigById(a.target_item_network);
      interaction = getActionInteraction(networkConfig, {
        actionType: a.action_type,
        fromNetwork: a.source_item_network,
        fromDomain: a.source_item_domain,
        fromItemType: a.source_item_type,
        toNetwork: a.target_item_network,
        toDomain: a.target_item_domain,
        toItemType: a.target_item_type,
      });
    } catch (err) {
      logger?.warn({ err, action_id: a.action_id }, 'retire: interaction unresolved — cancelling with fallback status');
    }

    // Retire must end EVERY still-open connection, so we always resolve a cancel
    // status: the interaction's own `cancel` bucket when defined, else a literal
    // 'cancelled' fallback for interactions the network doesn't track
    // (metric_categories null) — otherwise those actions dangle as Pending
    // forever against a profile that no longer exists.
    const cats = interaction?.metric_categories;
    const cancelStatus = cats?.cancel?.[0] ?? DEFAULT_CANCEL_STATUS;

    // Skip anything already terminal. Include the universal fallbacks so an
    // untracked action that's already cancelled/rejected isn't touched again.
    const terminal = new Set([
      ...(cats?.reject ?? []),
      ...(cats?.cancel ?? []),
      DEFAULT_CANCEL_STATUS,
      'rejected',
    ]);
    if (terminal.has(a.action_status)) continue;

    await tx
      .update(item_actions)
      .set({
        action_status: cancelStatus,
        remarks: a.remarks ?? RETIRE_CANCEL_REMARK,
        updated_at: sql`now()`,
      })
      .where(
        and(
          eq(item_actions.partition_network, a.partition_network),
          eq(item_actions.action_type, a.action_type),
          eq(item_actions.action_id, a.action_id),
        ),
      );
    cancelled += 1;
  }

  return cancelled;
}
