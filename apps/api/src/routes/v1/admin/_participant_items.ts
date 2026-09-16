import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';

/**
 * Shared readers for the participant admin routes.
 *
 * All three routes carried their own byte-identical `servedNetworks`, and
 * `participant.ts` and `participant_read.ts` additionally carried a
 * byte-identical `readItemsForUser` (`participant_decrypt.ts` builds its own
 * query — it projects different columns and joins the user table). That is why
 * the item ordering had to be changed in several places at once, which is the
 * thing most likely to be missed on the next edit. One copy, imported by all
 * three.
 */

/**
 * The ordering every participant item list this API returns must use.
 *
 * Exported rather than written out per query because `participant_decrypt.ts`
 * builds its own select (different columns, a user join) and so cannot reuse
 * `readItemsForUser` — sharing the ORDER BY is what actually keeps its response
 * in step with GET/POST `/admin/participant` instead of a comment claiming it
 * does.
 *
 * **Newest first, and that is contractual rather than incidental.** A
 * participant accumulates profiles (a POST without `item_id` inserts a new one
 * on every call), and callers read the list head-first — the voice bot renders
 * it into a length-capped prompt (`max_size_chars: 4000`) and keeps only the
 * first N characters. Oldest first meant the profile the participant had just
 * created was the one dropped.
 *
 * Two limits worth knowing before relying on this:
 *
 * - **`created_at`, not `updated_at`.** Editing an old profile does not lift it
 *   to the head. `created_at` is chosen because `updated_at` also moves for
 *   writes the participant never made — lifecycle transitions, consent
 *   promotion, the retire scrub — which would reshuffle the list for reasons
 *   invisible to the caller. Note the voice gateway's own projection comments
 *   its disambiguation as "most recently updated wins", so the two differ by
 *   design, not by oversight.
 * - **The tiebreak does not order same-millisecond writes meaningfully.**
 *   `items.created_at` is a JS `new Date()` default (millisecond resolution) and
 *   `item_id` is a random UUID, so rows written in the same millisecond are
 *   ordered by random bytes: stable across repeated calls, but arbitrary. Only a
 *   monotonic key (a bigserial, or `clock_timestamp()`) would make that case
 *   genuinely newest-first.
 */
export const ITEMS_NEWEST_FIRST = [desc(items.created_at), desc(items.item_id)];

/** Distinct networks this instance serves, derived from `SERVED_DOMAINS`. */
export const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

/**
 * Every item this user owns in a served network, decrypted and ISO-formatted,
 * ordered by {@link ITEMS_NEWEST_FIRST}.
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
    .orderBy(...ITEMS_NEWEST_FIRST);

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
