/**
 * Resolver for participant/decrypt field selection (#237). Pure functions:
 * given a decrypted merged item_state, the participant's account contact, the
 * requested fields, and the domain's contact-field context, produce the
 * filtered item_state. Canonical name/email/phone are mapped to the domain's
 * real field and fall back to the account row; other fields are read raw.
 */

export type CanonicalContact = 'name' | 'email' | 'phone';
const CANONICAL: readonly CanonicalContact[] = ['name', 'email', 'phone'];

/** Minimal pino-compatible surface for PII-free warnings. */
export interface ContactLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}

/** Per-(network,domain,item_type) resolution context, assembled by the caller. */
export interface DomainContactContext {
  network: string;
  domain: string;
  itemType: string;
  /** The domain's `contact_fields` map from network.json, if any. */
  contactFields?: { name?: string; email?: string; phone?: string };
  /** Fallback field name for `name`: item-type display_name_field or card.title_field. */
  nameFallbackField?: string;
}

/** The participant's account (user-row) contact, for canonical fallback. */
export interface AccountContact {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

const isCanonical = (f: string): f is CanonicalContact =>
  (CANONICAL as readonly string[]).includes(f);

/** True when a value is present and non-empty (empty string / whitespace = absent). */
function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/** The item_state field name for a canonical concept in this domain. */
function mappedField(ctx: DomainContactContext, f: CanonicalContact): string | undefined {
  const explicit = ctx.contactFields?.[f];
  if (explicit) return explicit;
  if (f === 'name') return ctx.nameFallbackField; // display_name_field / card.title_field
  return undefined; // phone/email have no default — mapping is required
}

/**
 * Builds the filtered item_state for the requested `fields`.
 *
 * @param mergedState - The DECRYPTED merged item_state (public + decrypted private).
 * @param account - The item creator's account contact (fallback source, 3 fields only).
 * @param fields - Requested field names (canonical name/email/phone + raw field names).
 * @param ctx - Domain contact-field context.
 * @param log - PII-free warning sink for missing canonical mappings.
 * @returns Filtered object: canonical under canonical keys (value or null),
 *   non-canonical under raw keys (omitted when absent).
 */
export function selectRequestedFields(
  mergedState: Record<string, unknown>,
  account: AccountContact,
  fields: string[],
  ctx: DomainContactContext,
  log: ContactLog,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (isCanonical(f)) {
      // canonical: mapped profile field → account fallback → null
      out[f] = resolveCanonicalField(f, mergedState, account, ctx, log);
    } else if (hasValue(mergedState[f])) {
      // non-canonical: raw item_state value, no fallback, omit when absent/empty
      out[f] = mergedState[f];
    }
  }
  return out;
}

/**
 * Resolves one canonical field: the mapped profile value wins; otherwise the
 * account value; otherwise `null`. Emits a PII-free warning when a phone/email
 * has no mapping (so it silently relies on the account fallback).
 */
function resolveCanonicalField(
  f: CanonicalContact,
  mergedState: Record<string, unknown>,
  account: AccountContact,
  ctx: DomainContactContext,
  log: ContactLog,
): unknown {
  const fieldName = mappedField(ctx, f);
  const fromState = fieldName ? mergedState[fieldName] : undefined;
  if (hasValue(fromState)) return fromState; // profile wins
  if (!fieldName && (f === 'phone' || f === 'email')) {
    log.warn(
      { operation: 'participant.decrypt.contact_map_missing', network: ctx.network, domain: ctx.domain, field: f },
      'no contact_fields mapping for requested canonical field; using account fallback',
    );
  }
  const fromAccount = account[f];
  return hasValue(fromAccount) ? fromAccount : null;
}
