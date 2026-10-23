/**
 * Resolvers for participant/decrypt's two independent concerns, both over the
 * decrypted merged state:
 *
 *  - `projectItemState` — a pure `item_state` projection for the `fields`
 *    param. No canonical mapping, no account read.
 *  - `resolveContact` — the canonical `contact` block: maps name/email/phone
 *    to the domain's field and falls back to the account row, with `source`.
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
  if (f === 'name') return ctx.nameFallbackField;
  return undefined; // phone/email have no default: mapping is required
}

/** Minimal domain-config shape needed to resolve the `name` fallback field. */
export interface DomainConfigForName {
  item_schemas?: Record<string, { display_name_field?: unknown } | undefined>;
  card?: { title_field?: unknown };
}

/**
 * The `name` fallback field: the item type's `display_name_field`, else the
 * domain's `card.title_field`. Used by the decrypt handler and
 * `private_display_name`; fetch_actions/metrics use `resolve_display_name`,
 * a different display_name_field-only rule.
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
 * `true` => all three canonical fields; `undefined` => no contact block; an
 * array passes through as the subset.
 */
export function normalizeContact(
  contact: true | CanonicalContact[] | undefined,
): CanonicalContact[] | undefined {
  if (contact === true) return [...CANONICAL];
  if (contact === undefined) return undefined;
  return contact;
}

/**
 * Projection for the `fields` param: raw keys only, absent/empty values
 * omitted, nothing resolved beyond what is literally in the state.
 */
export function projectItemState(
  mergedState: Record<string, unknown>,
  fields: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    // Own keys only: an inherited key (e.g. `toString`) or a literal
    // `__proto__` key must not read as a real field.
    if (!Object.hasOwn(mergedState, f)) continue;
    const v = mergedState[f];
    if (!hasValue(v)) continue;
    // `defineProperty` so a literal `__proto__` key cannot set the prototype.
    Object.defineProperty(out, f, { value: v, writable: true, enumerable: true, configurable: true });
  }
  return out;
}

/**
 * For each requested field the mapped profile value wins over the account
 * fallback; unresolved in both => `{ value: null, source: null }`. Logs a
 * PII-free warning for a config/data anomaly (missing phone/email mapping, or
 * a mapped value that is not a string), but not for a field left blank.
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
  const raw = fieldName ? mergedState[fieldName] : undefined;
  const fromState = asContactString(raw);
  if (fromState !== undefined) return { value: fromState, source: 'item' };
  if (fieldName && raw != null && typeof raw !== 'string') {
    // Present but not a string (e.g. a phone stored as a number): a schema/data
    // mismatch worth surfacing. Absent or empty keys do not warn, or every
    // unfilled optional field would log.
    log.warn(
      {
        operation: 'participant.decrypt.contact_map_type_mismatch',
        network: ctx.network,
        domain: ctx.domain,
        item_type: ctx.itemType,
        field: f,
        mapped_to: fieldName,
        value_type: typeof raw,
      },
      'contact_fields mapping resolved to a non-string value; using account fallback',
    );
  } else if (!fieldName && (f === 'phone' || f === 'email')) {
    log.warn(
      {
        operation: 'participant.decrypt.contact_map_missing',
        network: ctx.network,
        domain: ctx.domain,
        item_type: ctx.itemType,
        field: f,
      },
      'no contact_fields mapping for requested canonical field; using account fallback',
    );
  }
  const fromAccount = asContactString(account[f]);
  return fromAccount !== undefined ? { value: fromAccount, source: 'user' } : { value: null, source: null };
}

/**
 * Only a non-empty string is usable, so a mapping to a non-string field
 * degrades to the fallback instead of a response-serialization 500.
 */
function asContactString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() !== '' ? v : undefined;
}
