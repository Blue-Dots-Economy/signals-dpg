import { and, eq, or, sql } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import { getActionInteraction } from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import type { DbOrTx } from '@/services/item_service';

type WarnLogger = { warn: (obj: unknown, msg?: string) => void };

/**
 * The counterparty side of a connection cancelled by retire, returned so the
 * caller can notify them after the retire transaction commits. `ownerUserId` is
 * null for owner-less items and for counterparties on another instance; those
 * are skipped downstream, so only local counterparties are notified.
 */
export interface RetireCancelledCounterparty {
  actionId: string;
  actionType: string;
  ownerUserId: string | null;
  itemId: string;
  domain: string;
  network: string;
}

/** Cancel status for interactions with no `cancel` bucket in `metric_categories`. */
const DEFAULT_CANCEL_STATUS = 'cancelled';

/**
 * Remark stamped on a connection cancelled by retire, only when the action has
 * none, so the counterparty sees why it ended. Worded neutrally.
 */
const RETIRE_CANCEL_REMARK = 'This profile is retired and no longer available.';

/**
 * Cancel every still-open connection (as source or target) referencing an item
 * being retired. "Open" means the status is not in the interaction's `reject`
 * or `cancel` categories (nor `cancelled`/`rejected`). Each is moved to the
 * interaction's first `cancel` status, or `cancelled` when the interaction
 * defines none or cannot be resolved.
 *
 * The action rows are kept (only the status changes) so the counterparty keeps
 * their history. Runs inside the retire transaction; returns the counterparty
 * of each cancelled connection so the caller can notify them after commit.
 */
export async function cancelItemConnections(
  tx: DbOrTx,
  item: { item_id: string; item_network: string; item_domain: string; item_type: string },
  logger?: WarnLogger,
): Promise<RetireCancelledCounterparty[]> {
  // The full item ref on each side lets the source/target composite indexes
  // serve the query. It does not prune partitions: `partition_network` is not
  // filtered because a source-side action can live in another network's
  // partition.
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
      source_item_id: item_actions.source_item_id,
      source_item_owner: item_actions.source_item_owner,
      source_item_network: item_actions.source_item_network,
      source_item_domain: item_actions.source_item_domain,
      source_item_type: item_actions.source_item_type,
      target_item_id: item_actions.target_item_id,
      target_item_owner: item_actions.target_item_owner,
      target_item_network: item_actions.target_item_network,
      target_item_domain: item_actions.target_item_domain,
      target_item_type: item_actions.target_item_type,
    })
    .from(item_actions)
    .where(or(asSource, asTarget));

  const counterparties: RetireCancelledCounterparty[] = [];
  for (const a of actions) {
    // An interaction missing from config still gets cancelled via the fallback.
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

    // Always resolve a cancel status, or untracked actions would stay pending
    // forever against a profile that no longer exists.
    const cats = interaction?.metric_categories;
    const cancelStatus = cats?.cancel?.[0] ?? DEFAULT_CANCEL_STATUS;

    // The literal fallbacks keep an untracked, already-ended action untouched.
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

    // An action with the retired item on both sides has no counterparty, so the
    // retiring owner is never emailed about their own retire.
    const retiredIsSource = a.source_item_id === item.item_id;
    const cp = retiredIsSource
      ? {
          ownerUserId: a.target_item_owner,
          itemId: a.target_item_id,
          domain: a.target_item_domain,
          network: a.target_item_network,
        }
      : {
          ownerUserId: a.source_item_owner,
          itemId: a.source_item_id,
          domain: a.source_item_domain,
          network: a.source_item_network,
        };
    if (cp.itemId !== item.item_id) {
      counterparties.push({
        actionId: a.action_id,
        actionType: a.action_type,
        ...cp,
      });
    }
  }

  return counterparties;
}
