import { and, eq } from 'drizzle-orm';

import { db } from '@api/db/postgres/drizzle_config';
import { organization, user } from '@api/db/postgres/schema/auth';
import { items } from '@dpg/database';

/**
 * Placeholder address (`<uuid>@no-email.local`) that existing phone-only user
 * rows may carry. Nothing mints it today, but it is undeliverable, so it counts
 * as no email; sending to it would hard-bounce and hurt sender reputation.
 */
const SYNTHETIC_EMAIL_SUFFIX = '@no-email.local';

/** A deliverable email, or null for a missing or placeholder address. */
function deliverableEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.toLowerCase().endsWith(SYNTHETIC_EMAIL_SUFFIX) ? null : email;
}

/**
 * Resolves a local user's deliverable email, or null when the user is unknown
 * or has none. notification-service never looks up contacts itself.
 */
export async function resolveOwnerEmail(userId: string): Promise<string | null> {
  const rows = await db
    .select({ email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return deliverableEmail(rows[0]?.email);
}

/** Resolves an owner's display name and deliverable email in one lookup. */
export async function resolveOwnerNameEmail(
  userId: string,
): Promise<{ found: boolean; name: string | null; email: string | null }> {
  const rows = await db
    .select({ name: user.name, email: user.email })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  // `found` separates a phone-only owner (benign skip) from a missing row (a
  // defect, such as a broken `created_by`); the caller logs them differently.
  return { found: !!row, name: row?.name ?? null, email: deliverableEmail(row?.email) };
}

/** Resolves an org's display name by id; null when unknown or blank. */
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
 * Resolves a provider item's public service name (`jobProviderName`, not a
 * PII field), or null. `network` is the partition key, so the planner prunes
 * to one partition.
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
