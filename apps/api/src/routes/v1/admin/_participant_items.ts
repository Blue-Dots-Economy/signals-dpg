import { and, desc, eq, inArray } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { apiConfig } from '@/config';

/** Shared readers for the participant admin routes. */

/**
 * The ordering every participant item list this API returns must use. Exported
 * so `participant_decrypt.ts`, which builds its own select, stays in step.
 *
 * Newest first is contractual: a participant accumulates profiles, and callers
 * read the list head-first (the voice bot keeps only the first 4000 characters
 * of it in a prompt), so the newest profile must not be the one dropped.
 *
 * - `created_at`, not `updated_at`: `updated_at` also moves for writes the
 *   participant never made (lifecycle transitions, consent promotion, the
 *   retire scrub), which would reshuffle the list invisibly.
 * - Rows created in the same millisecond are ordered by the random `item_id`:
 *   stable across calls, but arbitrary.
 */
export const ITEMS_NEWEST_FIRST = [desc(items.created_at), desc(items.item_id)];

/** Distinct networks this instance serves, derived from `SERVED_DOMAINS`. */
export const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

/**
 * Every item this user owns in a served network, ordered by
 * {@link ITEMS_NEWEST_FIRST}, with private state merged in and the raw
 * encrypted blob dropped.
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
