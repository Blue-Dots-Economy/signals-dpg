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
 * Marks every pending action (status in PENDING_ACTION_STATUSES) involving
 * `item_id` (as source or target) as `cancelled`. MUST be called inside
 * the same transaction as the item update that triggered the leave-live
 * transition. Increments update_count so downstream metrics see the bump.
 *
 * Returns the count of rows that were cancelled (useful for logging).
 *
 * No action_event row is emitted here — counterparty notification is a
 * deferred follow-up spec (see §7 closing note).
 */
export const cancel_pending_actions_for_item = async (
  exec: DbOrTx,
  item_id: string,
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
