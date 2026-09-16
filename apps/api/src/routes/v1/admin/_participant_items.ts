import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';

/**
 * Shared readers for the participant admin routes.
 *
 * `participant.ts`, `participant_read.ts` and `participant_decrypt.ts` each
 * held their own byte-identical copy of these. That is how the three drifted
 * into answering the same question three times, and it is why the item
 * ordering below had to be changed in three places at once — the thing most
 * likely to be missed on the next edit. One copy, imported by all three.
 */

/** Distinct networks this instance serves, derived from `SERVED_DOMAINS`. */
export const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

/**
 * Every item this user owns in a served network, decrypted and ISO-formatted.
 *
 * **Ordered newest first**, and that is contractual rather than incidental: a
 * participant accumulates profiles (a POST without `item_id` inserts a new one
 * on every call), and callers read this list head-first — the voice bot renders
 * it into a length-capped prompt and keeps only the first N characters. Oldest
 * first meant the profile the participant had just created was the one dropped.
 *
 * `item_id` is the tiebreaker: two items written in the same millisecond would
 * otherwise come back in heap order, which can differ between two identical
 * calls.
 *
 * @param user_id - The participant's local `user.id`.
 * @returns The user's items, newest first, with private state merged in and the
 *   raw encrypted blob dropped.
 */
export async function readItemsForUser(user_id: string) {
  const networks = servedNetworks();
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      lifecycle_status: items.lifecycle_status,
      item_state: items.item_state,
      item_locations: items.item_locations,
      item_private_state: items.item_private_state,
      created_at: items.created_at,
      updated_at: items.updated_at,
    })
    .from(items)
    .where(
      networks.length > 0
        ? and(eq(items.created_by, user_id), inArray(items.item_network, networks))
        : eq(items.created_by, user_id),
    )
    .orderBy(desc(items.created_at), desc(items.item_id));

  return rows.map((r) => {
    const { item_private_state: _drop, ...rest } = r;
    const { mergedState } = decryptItemPrivate({
      item_state: r.item_state as Record<string, unknown>,
      item_private_state: r.item_private_state,
    });
    return {
      ...rest,
      item_state: mergedState,
      created_at: (r.created_at as Date).toISOString(),
      updated_at: (r.updated_at as Date).toISOString(),
    };
  });
}
