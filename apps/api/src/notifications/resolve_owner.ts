import { and, eq } from 'drizzle-orm';

import { db } from '@api/db/postgres/drizzle_config';
import { organization, user } from '@api/db/postgres/schema/auth';
import { getNetworkConfigById } from '@/network_configs';
import { resolveNameFallbackField, type DomainConfigForName } from '@/utils/contact_fields';
import { items } from '@dpg/database';

/**
 * Suffix of the synthetic address `/participant` (`participant.ts`) mints for a
 * phone-only signup (`${randomUUID()}@no-email.local`) because better-auth's
 * `signUpEmail` requires a non-null email. It is deliverable to nobody, so for
 * notification purposes it is "no email" — treating it as a real address would
 * hard-bounce thousands of sends from the OTP sender identity on a bulk
 * phone-only onboard, damaging login sender reputation (#592 Blocker 2).
 */
const SYNTHETIC_EMAIL_SUFFIX = '@no-email.local';

/**
 * A deliverable email, or null. Folds the phone-only synthetic address
 * ({@link SYNTHETIC_EMAIL_SUFFIX}) into null so callers skip the send.
 */
function deliverableEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.toLowerCase().endsWith(SYNTHETIC_EMAIL_SUFFIX) ? null : email;
}

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
  return deliverableEmail(rows[0]?.email);
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
  // A phone-only owner may carry a synthetic `@no-email.local` address; fold it
  // to null so the caller treats it as no-email (see {@link deliverableEmail}).
  return { found: !!row, name: row?.name ?? null, email: deliverableEmail(row?.email) };
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

/** One item's public state plus the partition keys needed to find its schema. */
interface ProviderItemRow {
  state: Record<string, unknown>;
  domain: string;
  type: string;
}

/**
 * Loads a provider item's public state and its domain/type partition keys.
 *
 * `network` is the item's partition key — filtering on it lets the planner
 * prune to the right partition instead of scanning every network's items.
 */
async function loadProviderItem(itemId: string, network: string): Promise<ProviderItemRow | null> {
  const rows = await db
    .select({ state: items.item_state, domain: items.item_domain, type: items.item_type })
    .from(items)
    .where(and(eq(items.item_network, network), eq(items.item_id, itemId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    state: (row.state ?? {}) as Record<string, unknown>,
    domain: row.domain,
    type: row.type,
  };
}

/**
 * The item_state field a network declares for a concept, read off the item's own
 * domain/item-type config. `pick` selects the key (`display_name_field` for the
 * public name, `offering_field` for what the org offers). Null when the network
 * config can't be loaded — callers fall back rather than fail a notification.
 */
async function declaredField(
  network: string,
  row: ProviderItemRow,
  pick: (domainCfg: DomainConfigForName | undefined, itemType: string) => string | undefined,
): Promise<string | null> {
  try {
    const cfg = await getNetworkConfigById(network);
    const domainCfg = cfg.domains.find((d) => d.id === row.domain) as
      | DomainConfigForName
      | undefined;
    return pick(domainCfg, row.type) ?? null;
  } catch {
    // Config lookup is best-effort here: a refetch blip must not turn a
    // notification into an error. The caller's fallback copy still reads.
    return null;
  }
}

/** Trimmed string, or null for anything else (absent, blank, non-string). */
function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * Resolves a provider item's public service name by item id. Used to substitute
 * `{name}` in seeker-facing action emails and `{org}` in the guardian consent
 * email. Returns null when unknown. The field is public (not a masked PII field).
 *
 * The field name comes from the network's own schema (`display_name_field`,
 * else the domain's `card.title_field`) rather than a hardcoded key, so every
 * network resolves a real name: blue_dot `jobProviderName`, purple_dot
 * `organisation_name`, orange_dot `product_name`, yellow_dot `Full Name`.
 * `jobProviderName` stays the last-resort fallback for an unconfigured domain.
 */
export async function resolveProviderServiceName(
  itemId: string,
  network: string,
): Promise<string | null> {
  const row = await loadProviderItem(itemId, network);
  if (!row) return null;
  const field = await declaredField(network, row, resolveNameFallbackField);
  return cleanString(row.state[field ?? 'jobProviderName']) ?? cleanString(row.state.jobProviderName);
}

/**
 * Resolves what a provider org offers, as a human-readable phrase, for the
 * guardian consent email ("They offer …"). The source field is declared per
 * item schema as `offering_field` (purple_dot: `services_offered`); a network
 * that declares none has no offering to show and returns null.
 *
 * Array values (multi-select enums) are joined; a plain string passes through.
 * Returns null when the field is absent or empty so the caller can fall back —
 * the copy file has no conditionals.
 */
export async function resolveProviderOffering(
  itemId: string,
  network: string,
): Promise<string | null> {
  const row = await loadProviderItem(itemId, network);
  if (!row) return null;
  const field = await declaredField(network, row, (domainCfg, itemType) => {
    const declared = domainCfg?.item_schemas?.[itemType]?.offering_field;
    return typeof declared === 'string' ? declared : undefined;
  });
  if (!field) return null;

  const value = row.state[field];
  if (Array.isArray(value)) {
    const parts = value.map(cleanString).filter((v): v is string => v !== null);
    return parts.length ? parts.join(', ') : null;
  }
  return cleanString(value);
}
