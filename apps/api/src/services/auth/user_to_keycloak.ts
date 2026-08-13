/**
 * Mapping a signals `user` row onto a Keycloak user representation, for the
 * migration (§6.1 of docs/superpowers/plans/2026-07-23-keycloak-migration-design.md).
 *
 * Pure — no db, no config, no network — because this is the part that must be
 * exactly right and is worth exhaustive unit coverage. The Admin-REST plumbing
 * lives in `keycloak_admin.ts` and the orchestration in
 * `scripts/migrate_users_to_keycloak.ts`.
 *
 * **Two rules govern everything here.**
 *
 * 1. **`id` is carried over verbatim.** `keycloak user.id == sub == signals
 *    user.id`, which is what lets `items.created_by` and every `*_owner` text
 *    column stay untouched across all partitions (§2.3, risk R4). Nothing in
 *    this file may generate an id.
 *
 * 2. **Signals-owned columns are NOT sent.** `date_of_birth`, `domains`,
 *    `terms_accepted`, `privacy_accepted`, the `onboarded_*` attribution and
 *    `tags` stay authoritative in Postgres. Copying them into Keycloak would
 *    create a second source of truth for data signals has to query, join,
 *    aggregate and FK on — the thing §6.0 exists to prevent. The omission is
 *    deliberate and is asserted in the tests.
 */

/** The subset of the `user` row the migration reads. */
export interface SignalsUserRow {
  id: string;
  name: string;
  email: string | null;
  emailVerified: boolean;
  phoneNumber: string | null;
  phoneNumberVerified: boolean | null;
  role: string | null;
  banned: boolean | null;
  banReason: string | null;
  banExpires: Date | null;
}

/** Keycloak's UserRepresentation, narrowed to the fields we set. */
export interface KeycloakUserRepresentation {
  id: string;
  username: string;
  enabled: boolean;
  email?: string;
  emailVerified: boolean;
  firstName?: string;
  lastName?: string;
  attributes: Record<string, string[]>;
  realmRoles: string[];
  /** Always empty: OTP login means there are no credentials to migrate. */
  credentials: never[];
  /** Always empty: a migrated user must not be forced through extra steps. */
  requiredActions: never[];
}

/** Realm roles, namespaced away from aggregator's `org_owner` (risk R9). */
export const SIGNALS_PARTICIPANT_ROLE = 'signals_participant';
export const SIGNALS_ADMIN_ROLE = 'signals_admin';

export type MappingErrorCode = 'NO_IDENTIFIER' | 'NO_ID';

export type MappingResult =
  | { ok: true; user: KeycloakUserRepresentation }
  | { ok: false; code: MappingErrorCode; message: string };

/**
 * Split the single `name` column into Keycloak's first/last.
 *
 * Everything after the first token becomes the last name, so "Asha Rao Kumar"
 * keeps "Rao Kumar" together rather than dropping a middle name. A single-token
 * name yields no last name at all — the realm's user profile does not require
 * one, and inventing a placeholder would put junk in front of the user.
 */
export function splitName(name: string): { firstName?: string; lastName?: string } {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { firstName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

/**
 * The Keycloak username for a signals user.
 *
 * Email first (the realm sets `loginWithEmailAllowed`), then phone, and the
 * user id as a last resort. All three are unique in signals — `email` and
 * `phone_number` carry unique constraints and `id` is the primary key — so this
 * cannot collide within the migrated population.
 *
 * Lowercased because Keycloak treats usernames case-insensitively and would
 * otherwise reject "Asha@x.org" as a duplicate of an existing "asha@x.org".
 */
export function keycloakUsername(row: SignalsUserRow): string | null {
  const email = row.email?.trim().toLowerCase();
  if (email) return email;
  const phone = row.phoneNumber?.trim();
  if (phone) return phone.toLowerCase();
  return row.id ? row.id.toLowerCase() : null;
}

/** Realm role for a signals `user.role`. Anything unrecognised is a participant. */
export function realmRoleFor(role: string | null): string {
  return role === 'admin' ? SIGNALS_ADMIN_ROLE : SIGNALS_PARTICIPANT_ROLE;
}

export function mapUserToKeycloak(row: SignalsUserRow): MappingResult {
  if (!row.id?.trim()) {
    return { ok: false, code: 'NO_ID', message: 'user row has no id' };
  }

  // A row with neither email nor phone cannot log in via OTP and has no
  // username to key on. Surfaced rather than silently given an id-as-username,
  // because it almost certainly means bad data worth an operator's attention.
  if (!row.email?.trim() && !row.phoneNumber?.trim()) {
    return {
      ok: false,
      code: 'NO_IDENTIFIER',
      message: 'user row has neither an email nor a phone number',
    };
  }

  const username = keycloakUsername(row);
  if (!username) {
    return { ok: false, code: 'NO_IDENTIFIER', message: 'could not derive a username' };
  }

  const attributes: Record<string, string[]> = {};
  const phone = row.phoneNumber?.trim();
  if (phone) {
    // The attribute name the realm's OTP authenticator and the phone_number
    // protocol mapper both read (`otpChoice.phoneAttribute: phoneNumber`).
    attributes.phoneNumber = [phone];
    // §6.3 spike 3: carry the verified flag over so cutover does not force
    // every already-verified user to re-verify.
    attributes.phoneNumberVerified = [String(row.phoneNumberVerified === true)];
  }

  // Ban metadata has no native Keycloak home; `enabled` carries the decision
  // and these keep the reason auditable on the Keycloak side.
  if (row.banned) {
    if (row.banReason?.trim()) attributes.banReason = [row.banReason.trim()];
    if (row.banExpires) attributes.banExpires = [row.banExpires.toISOString()];
  }

  const email = row.email?.trim().toLowerCase();

  return {
    ok: true,
    user: {
      id: row.id,
      username,
      // R8: a banned user migrates as a disabled Keycloak user, so Keycloak
      // will not mint them a token in the first place.
      enabled: row.banned !== true,
      ...(email ? { email } : {}),
      emailVerified: Boolean(email) && row.emailVerified === true,
      ...splitName(row.name ?? ''),
      attributes,
      realmRoles: [realmRoleFor(row.role)],
      credentials: [],
      requiredActions: [],
    },
  };
}
