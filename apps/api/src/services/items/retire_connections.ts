import { and, eq, or, sql } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import { getActionInteraction } from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import type { DbOrTx } from '@/services/item_service';

type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

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
  itemId: string,
  logger?: WarnLogger,
): Promise<number> {
  const actions = await tx
    .select({
      partition_network: item_actions.partition_network,
      action_type: item_actions.action_type,
      action_id: item_actions.action_id,
      action_status: item_actions.action_status,
      source_item_network: item_actions.source_item_network,
      source_item_domain: item_actions.source_item_domain,
      source_item_type: item_actions.source_item_type,
      target_item_network: item_actions.target_item_network,
      target_item_domain: item_actions.target_item_domain,
      target_item_type: item_actions.target_item_type,
    })
    .from(item_actions)
    .where(
      or(eq(item_actions.source_item_id, itemId), eq(item_actions.target_item_id, itemId)),
    );

  let cancelled = 0;
  for (const a of actions) {
    let interaction: ReturnType<typeof getActionInteraction>;
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
      // Interaction no longer defined in config — can't resolve a cancel status.
      logger?.warn({ err, action_id: a.action_id }, 'retire: skipping action with no resolvable interaction');
      continue;
    }

    const cats = interaction.metric_categories;
    const cancelStatus = cats?.cancel?.[0];
    if (!cats || !cancelStatus) continue; // untracked / no cancel status → leave

    const terminal = new Set([...(cats.reject ?? []), ...(cats.cancel ?? [])]);
    if (terminal.has(a.action_status)) continue; // already terminal

    await tx
      .update(item_actions)
      .set({ action_status: cancelStatus, updated_at: sql`now()` })
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
