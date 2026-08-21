import { and, eq } from 'drizzle-orm';

import { db } from '@api/db/postgres/drizzle_config';
import { organization, user } from '@api/db/postgres/schema/auth';
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
 * Resolves an owner's display name + email in one lookup. Used by the
 * item-lifecycle emails (#531/#534) which greet the owner by name and address
 * the send to their email. Either field is null when unknown / not set
 * (phone-only users have no email → the caller skips the email).
 */
export async function resolveOwnerNameEmail(
  userId: string,
): Promise<{ found: boolean; name: string | null; email: string | null }> {
  const rows = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  // `found` distinguishes a phone-only owner (row exists, email null — benign
  // skip) from a missing row (no match for `userId` — a real defect signal:
  // a broken `created_by` or a wrong id threaded from the route). The caller
  // logs the two differently rather than silently skipping both.
  return { found: !!row, name: row?.name ?? null, email: row?.email ?? null };
}

/**
 * Resolves an org's display name by id (the `organization` table — `org_id`
 * from the acting-org context). Used to name the onboarding aggregator in the
 * initiation email. Null when unknown, so the caller can fall back.
 */
export async function resolveOrgName(orgId: string): Promise<string | null> {
  const rows = await db
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);
  const name = rows[0]?.name;
  return typeof name === 'string' && name.trim() ? name : null;
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
