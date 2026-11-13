import { and, eq } from 'drizzle-orm';

import { db } from '@api/db/postgres/drizzle_config';
import { organization, user } from '@api/db/postgres/schema/auth';
import { items } from '@dpg/database';
import { getNetworkConfigById } from '@/network_configs';

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

/** Resolves an owner's display name, deliverable email and phone in one lookup. */
export async function resolveOwnerNameEmail(userId: string): Promise<{
  found: boolean;
  name: string | null;
  email: string | null;
  phone: string | null;
  phoneVerified: boolean;
}> {
  const rows = await db
    .select({
      name: user.name,
      email: user.email,
      phone: user.phoneNumber,
      phoneVerified: user.phoneNumberVerified,
    })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  const row = rows[0];
  // `found` separates a phone-only owner (benign skip) from a missing row (a
  // defect, such as a broken `created_by`); the caller logs them differently.
  return {
    found: !!row,
    name: row?.name ?? null,
    email: deliverableEmail(row?.email),
    phone: row?.phone ?? null,
    phoneVerified: row?.phoneVerified === true,
  };
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
 * A provider item's name from its schema's `display_name_field`, or null.
 * The config loader rejects a private `display_name_field`, so the value is public.
 */
export async function resolveProviderServiceName(
  itemId: string,
  network: string,
): Promise<string | null> {
  const rows = await db
    .select({ state: items.item_state, domain: items.item_domain, type: items.item_type })
    .from(items)
    .where(and(eq(items.item_network, network), eq(items.item_id, itemId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  // Best-effort like the DB lookup: callers fall back to generic copy on null.
  const config = await getNetworkConfigById(network).catch(() => null);
  if (!config) return null;
  const schema = config.domains.find((d) => d.id === row.domain)?.item_schemas?.[row.type] as
    | { display_name_field?: unknown }
    | undefined;
  const field = schema?.display_name_field;
  if (typeof field !== 'string') return null;
  const name = (row.state as Record<string, unknown> | null | undefined)?.[field];
  return typeof name === 'string' && name.trim() ? name : null;
}
