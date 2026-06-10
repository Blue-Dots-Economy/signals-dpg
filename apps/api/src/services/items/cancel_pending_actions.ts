import { and, eq, inArray, or, sql } from 'drizzle-orm';
import { item_actions } from '@dpg/database';
import type { db as dbType } from '@api/db/postgres/drizzle_config';

type Tx = Parameters<Parameters<typeof dbType.transaction>[0]>[0];
type DbOrTx = typeof dbType | Tx;

/**
 * Action statuses that count as "pending" — eligible for auto-cancel when
 * an endpoint item leaves `live`. Anything outside this set is terminal
 * or already accepted and is left alone (see spec §7).
 */
export const PENDING_ACTION_STATUSES = ['created', 'submitted'] as const;

export const isPendingStatus = (s: string): boolean =>
  (PENDING_ACTION_STATUSES as readonly string[]).includes(s);

/**
 * Marks every pending action involving `item_id` (as source or target) as
 * `cancelled`. MUST run in the same transaction as the item update that
 * triggered the leave-live transition. Returns the count cancelled.
 *
 * @param exec  - A Drizzle db handle or an already-open transaction.
 * @param item_id - The item whose pending actions should be cancelled.
 * @param network - The network the item belongs to (`partition_network`).
 *                  Used to prune the partition scan to a single shard.
 */
export const cancel_pending_actions_for_item = async (
  exec: DbOrTx,
  item_id: string,
  network: string,
): Promise<number> => {
  const result = await exec
    .update(item_actions)
    .set({
      action_status: 'cancelled',
      update_count: sql`${item_actions.update_count} + 1`,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(item_actions.partition_network, network),
        or(
          eq(item_actions.source_item_id, item_id),
          eq(item_actions.target_item_id, item_id),
        ),
        inArray(item_actions.action_status, [...PENDING_ACTION_STATUSES]),
      ),
    )
    .returning({ action_id: item_actions.action_id });

  return result.length;
};
