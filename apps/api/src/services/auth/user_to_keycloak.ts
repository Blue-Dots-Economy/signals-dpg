/**
 * Maps a signals `user` row onto a Keycloak user representation. Used by the
 * migration, self-signup and admin participant onboarding. Pure: no db, config
 * or network.
 *
 * 1. `id` is carried over verbatim (`keycloak user.id == sub == signals
 *    user.id`), so `items.created_by` and every `*_owner` column stay valid.
 *    Nothing here may generate an id.
 *
 * 2. Signals-owned columns are not sent: `age`, `domains`, `terms_accepted`,
 *    `privacy_accepted`, the `onboarded_*` attribution and `tags` stay
 *    authoritative in Postgres, so there is no second source of truth.
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

/** Realm roles, namespaced away from aggregator's `org_owner`. */
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
 * keeps "Rao Kumar" together. A single-token name yields no last name; the
 * realm's user profile does not require one.
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
 * Email first (the realm sets `loginWithEmailAllowed`), then phone, then the
 * user id. All three are unique in signals, so usernames cannot collide among
 * migrated users. Lowercased because Keycloak treats usernames
 * case-insensitively.
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

  // A row with neither email nor phone cannot log in via OTP. Surfaced rather
  // than given an id-as-username, because it almost certainly means bad data.
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
    // Carry the verified flag so already-verified users need not re-verify.
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
      // A banned user becomes a disabled Keycloak user, so Keycloak mints no
      // token for them.
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
