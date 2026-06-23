import { and, eq } from 'drizzle-orm';

import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';
import { items } from '@dpg/database';

/**
 * Resolves a local owner's email by better-auth user id. Returns null when the
 * user is unknown or has no email (phone-only). The email is used only to
 * address the notification-service request; it is never derived on the wire by
 * NS (which stays contact-blind).
 */
export async function resolveOwnerEmail(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.email ?? null;
}

/**
 * Resolves a provider item's public service name (`jobProviderName`) by item id.
 * Used to substitute `{name}` in seeker-facing action emails. Returns null when
 * unknown. The field is public (not a masked PII field).
 *
 * `network` is the item's partition key — filtering on it lets the planner
 * prune to the right partition instead of scanning every network's items.
 */
export async function resolveProviderServiceName(
  itemId: string,
  network: string,
): Promise<string | null> {
  const rows = await db
    .select({ state: items.item_state })
    .from(items)
    .where(and(eq(items.item_network, network), eq(items.item_id, itemId)))
    .limit(1);
  const state = rows[0]?.state as Record<string, unknown> | undefined;
  const name = state?.jobProviderName;
  return typeof name === 'string' && name.trim() ? name : null;
}
