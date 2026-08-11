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

/** Minimal domain-config shape needed to resolve the `name` fallback field. */
export interface DomainConfigForName {
  item_schemas?: Record<string, { display_name_field?: unknown } | undefined>;
  card?: { title_field?: unknown } | undefined;
}

/**
 * The item_state field a domain uses as the `name` fallback: the item-type's
 * `display_name_field`, else the domain's `card.title_field`. Single, typed
 * source for the precedence otherwise re-implemented (with raw casts) in the
 * decrypt handler and `private_display_name`.
 *
 * @param domainCfg - The resolved domain config (may be undefined).
 * @param itemType - The item type whose display field is wanted.
 * @returns The fallback field name, or undefined when neither is set.
 */
export function resolveNameFallbackField(
  domainCfg: DomainConfigForName | undefined,
  itemType: string,
): string | undefined {
  const displayName = domainCfg?.item_schemas?.[itemType]?.display_name_field;
  if (typeof displayName === 'string') return displayName;
  const cardTitle = domainCfg?.card?.title_field;
  return typeof cardTitle === 'string' ? cardTitle : undefined;
}

/**
 * Normalizes the request's `contact` param to the concrete list of canonical
 * fields to resolve. `true` => all three; `undefined` => no contact block
 * (don't attach `contact` at all); an array passes through as the subset.
 */
export function normalizeContact(
  contact: true | CanonicalContact[] | undefined,
): CanonicalContact[] | undefined {
  if (contact === true) return [...CANONICAL];
  if (contact === undefined) return undefined;
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
    // Own enumerable keys only: an inherited key (e.g. `toString`) must not read
    // as present, and a participant-supplied literal `__proto__` key must not be
    // treated as a real field.
    if (!Object.hasOwn(mergedState, f)) continue;
    const v = mergedState[f];
    if (!hasValue(v)) continue;
    // `defineProperty` (not `out[f] = v`) so a literal `__proto__` key becomes a
    // plain own data property instead of mutating the output's prototype.
    Object.defineProperty(out, f, { value: v, writable: true, enumerable: true, configurable: true });
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
  const fromState = asContactString(fieldName ? mergedState[fieldName] : undefined);
  if (fromState !== undefined) return { value: fromState, source: 'item' }; // profile wins
  if (fieldName) {
    // A mapping exists but resolved to nothing usable. If the mapped key is
    // entirely ABSENT from item_state (vs present-but-empty, which is normal
    // participant data), the mapping likely points at a renamed/mistyped field
    // — surface it rather than silently returning the account value as `user`.
    if (!Object.hasOwn(mergedState, fieldName)) {
      log.warn(
        {
          operation: 'participant.decrypt.contact_map_stale',
          network: ctx.network,
          domain: ctx.domain,
          field: f,
          mapped_to: fieldName,
        },
        'contact_fields mapping points at a field absent from item_state; using account fallback',
      );
    }
  } else if (f === 'phone' || f === 'email') {
    log.warn(
      { operation: 'participant.decrypt.contact_map_missing', network: ctx.network, domain: ctx.domain, field: f },
      'no contact_fields mapping for requested canonical field; using account fallback',
    );
  }
  const fromAccount = asContactString(account[f]);
  return fromAccount !== undefined ? { value: fromAccount, source: 'user' } : { value: null, source: null };
}

/**
 * A contact value is usable only if it's a non-empty string. Guards the
 * strictly-typed `contact.value` (string | null) against a `contact_fields`
 * mapping that points at a non-string item_state field: such a value degrades
 * to the account fallback (or null) rather than a response-serialization 500.
 */
function asContactString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
