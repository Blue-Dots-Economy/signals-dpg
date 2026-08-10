/**
 * Resolver for participant/decrypt's two independent, decrypted-state-derived
 * concerns (#521 reshape of #237):
 *
 *  - `projectItemState` — a PURE `item_state` projection for the `fields`
 *    request param. No canonical special-casing, no `user` (account) read.
 *  - `resolveContact` — the canonical `contact` block: maps
 *    name/email/phone to the domain's real field, reads the DECRYPTED value,
 *    and falls back to the account row with provenance (`source`).
 *
 * These used to be one function (`selectRequestedFields`) that conflated the
 * two; #521 decouples them so `fields` and `contact` can be requested
 * independently (see docs/superpowers/specs/2026-08-07-participant-decrypt-field-resolution-design.md).
 */

export type CanonicalContact = 'name' | 'email' | 'phone';
export const CANONICAL: readonly CanonicalContact[] = ['name', 'email', 'phone'];

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

/** One resolved canonical contact value: where it came from, or unresolved. */
export interface ContactResolution {
  value: string | null;
  source: 'item' | 'user' | null;
}

const isCanonical = (f: string): f is CanonicalContact =>
  (CANONICAL as readonly string[]).includes(f);

/** True when a value is present and non-empty (empty string / whitespace = absent). */
export function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === 'string') return v.trim() !== '';
  return true;
}

/** The item_state field name for a canonical concept in this domain. */
export function mappedField(ctx: DomainContactContext, f: CanonicalContact): string | undefined {
  const explicit = ctx.contactFields?.[f];
  if (explicit) return explicit;
  if (f === 'name') return ctx.nameFallbackField; // display_name_field / card.title_field
  return undefined; // phone/email have no default — mapping is required
}

/**
 * Normalizes the request's `contact` param to the concrete list of canonical
 * fields to resolve. `true` => all three; `false`/`undefined` => no contact
 * block (undefined signals "don't attach `contact` at all").
 */
export function normalizeContact(
  contact: boolean | CanonicalContact[] | undefined,
): CanonicalContact[] | undefined {
  if (contact === true) return [...CANONICAL];
  if (contact === false || contact === undefined) return undefined;
  return contact;
}

/**
 * Pure `item_state` projection for the `fields` request param: raw keys only,
 * absent/empty values omitted. No canonical mapping, no `user` (account)
 * read — `fields` never resolves anything beyond what is literally present in
 * the decrypted merged state.
 *
 * @param mergedState - The DECRYPTED merged item_state (public + decrypted private).
 * @param fields - Requested raw field names.
 */
export function projectItemState(
  mergedState: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (hasValue(mergedState[f])) out[f] = mergedState[f];
  }
  return out;
}

/**
 * Resolves the canonical `contact` block: for each requested canonical field,
 * the mapped profile value wins over the account fallback; unresolved in both
 * => `{ value: null, source: null }`. Emits a PII-free warning when a
 * phone/email has no mapping (so it silently relies on the account fallback).
 *
 * @param mergedState - The DECRYPTED merged item_state (public + decrypted private).
 * @param account - The item creator's account contact (fallback source, 3 fields only).
 * @param requested - Subset of {name,email,phone} to resolve.
 * @param ctx - Domain contact-field context.
 * @param log - PII-free warning sink for missing canonical mappings.
 */
export function resolveContact(
  mergedState: Record<string, unknown>,
  account: AccountContact,
  requested: CanonicalContact[],
  ctx: DomainContactContext,
  log: ContactLog,
): Partial<Record<CanonicalContact, ContactResolution>> {
  const out: Partial<Record<CanonicalContact, ContactResolution>> = {};
  for (const f of requested) {
    if (!isCanonical(f)) continue; // defensive; schema already constrains this
    out[f] = resolveCanonicalField(f, mergedState, account, ctx, log);
  }
  return out;
}

function resolveCanonicalField(
  f: CanonicalContact,
  mergedState: Record<string, unknown>,
  account: AccountContact,
  ctx: DomainContactContext,
  log: ContactLog,
): ContactResolution {
  const fieldName = mappedField(ctx, f);
  const fromState = fieldName ? mergedState[fieldName] : undefined;
  if (hasValue(fromState)) return { value: fromState as string, source: 'item' }; // profile wins
  if (!fieldName && (f === 'phone' || f === 'email')) {
    log.warn(
      { operation: 'participant.decrypt.contact_map_missing', network: ctx.network, domain: ctx.domain, field: f },
      'no contact_fields mapping for requested canonical field; using account fallback',
    );
  }
  const fromAccount = account[f];
  return hasValue(fromAccount) ? { value: fromAccount as string, source: 'user' } : { value: null, source: null };
}
