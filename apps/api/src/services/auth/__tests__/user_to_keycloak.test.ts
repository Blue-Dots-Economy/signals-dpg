import { describe, it, expect } from 'vitest';
import {
  keycloakUsername,
  mapUserToKeycloak,
  realmRoleFor,
  splitName,
  SIGNALS_ADMIN_ROLE,
  SIGNALS_PARTICIPANT_ROLE,
  type SignalsUserRow,
} from '../user_to_keycloak.js';

/**
 * The field mapping for the user migration (§6.1). This is the highest-stakes
 * pure function in the migration: the two invariants it must never break are
 * that `id` is carried over verbatim (risk R4) and that signals-owned columns
 * are never copied into Keycloak (§6.0).
 */

const ID = '11111111-2222-3333-4444-555555555555';

function row(overrides: Partial<SignalsUserRow> = {}): SignalsUserRow {
  return {
    id: ID,
    name: 'Asha Rao',
    email: 'asha@example.org',
    emailVerified: true,
    phoneNumber: '+919876543210',
    phoneNumberVerified: true,
    role: 'user',
    banned: false,
    banReason: null,
    banExpires: null,
    ...overrides,
  };
}

describe('splitName', () => {
  it('splits first and last', () => {
    expect(splitName('Asha Rao')).toEqual({ firstName: 'Asha', lastName: 'Rao' });
  });

  it('keeps a middle name with the last name rather than dropping it', () => {
    expect(splitName('Asha Rao Kumar')).toEqual({
      firstName: 'Asha',
      lastName: 'Rao Kumar',
    });
  });

  it('yields no last name for a single token', () => {
    expect(splitName('Asha')).toEqual({ firstName: 'Asha' });
  });

  it('collapses extra whitespace', () => {
    expect(splitName('  Asha   Rao  ')).toEqual({ firstName: 'Asha', lastName: 'Rao' });
  });

  it('returns nothing for an empty name', () => {
    expect(splitName('   ')).toEqual({});
  });
});

describe('keycloakUsername', () => {
  it('prefers email', () => {
    expect(keycloakUsername(row())).toBe('asha@example.org');
  });

  it('lowercases, since Keycloak compares usernames case-insensitively', () => {
    expect(keycloakUsername(row({ email: 'Asha@Example.ORG' }))).toBe('asha@example.org');
  });

  it('falls back to phone for a phone-only user', () => {
    expect(keycloakUsername(row({ email: null }))).toBe('+919876543210');
  });

  it('falls back to the id when there is no identifier', () => {
    expect(keycloakUsername(row({ email: null, phoneNumber: null }))).toBe(
      ID.toLowerCase()
    );
  });
});

describe('realmRoleFor', () => {
  it('maps admin to the namespaced signals admin role', () => {
    // Namespaced away from aggregator's org_owner — realm roles are a shared
    // namespace in the bluedots realm (risk R9).
    expect(realmRoleFor('admin')).toBe(SIGNALS_ADMIN_ROLE);
    expect(SIGNALS_ADMIN_ROLE).toBe('signals_admin');
  });

  it('maps everything else to participant', () => {
    expect(realmRoleFor('user')).toBe(SIGNALS_PARTICIPANT_ROLE);
    expect(realmRoleFor(null)).toBe(SIGNALS_PARTICIPANT_ROLE);
    expect(realmRoleFor('something-unexpected')).toBe(SIGNALS_PARTICIPANT_ROLE);
  });
});

describe('mapUserToKeycloak', () => {
  it('carries the id over verbatim — the linchpin of the whole migration', () => {
    const result = mapUserToKeycloak(row());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // If this ever stops holding, every items.created_by and *_owner column
    // across all partitions stops matching its identity (§2.3, R4).
    expect(result.user.id).toBe(ID);
  });

  it('maps the full happy path', () => {
    const result = mapUserToKeycloak(row());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).toMatchObject({
      id: ID,
      username: 'asha@example.org',
      enabled: true,
      email: 'asha@example.org',
      emailVerified: true,
      firstName: 'Asha',
      lastName: 'Rao',
      realmRoles: [SIGNALS_PARTICIPANT_ROLE],
    });
    expect(result.user.attributes.phoneNumber).toEqual(['+919876543210']);
    expect(result.user.attributes.phoneNumberVerified).toEqual(['true']);
  });

  it('never sends signals-owned columns to Keycloak', () => {
    // §6.0: these stay authoritative in Postgres because signals has to query,
    // join, aggregate and FK on them. A second source of truth would defeat
    // the entire ownership split.
    const result = mapUserToKeycloak(row());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const serialised = JSON.stringify(result.user);
    for (const forbidden of [
      'dateOfBirth',
      'date_of_birth',
      'domains',
      'termsAccepted',
      'terms_accepted',
      'privacyAccepted',
      'onboardedByOrgId',
      'onboarded_by_org_id',
      'onboardedVia',
      'tags',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('migrates no credentials and forces no required actions', () => {
    // Login is passwordless OTP, so there is nothing to rehash (§6.2); and a
    // migrated user must not be met with an extra step at first login.
    const result = mapUserToKeycloak(row());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.credentials).toEqual([]);
    expect(result.user.requiredActions).toEqual([]);
  });

  it('preserves verified flags so cutover does not force re-verification', () => {
    // §6.3 spike 3.
    const verified = mapUserToKeycloak(row());
    expect(verified.ok && verified.user.emailVerified).toBe(true);
    expect(verified.ok && verified.user.attributes.phoneNumberVerified).toEqual(['true']);

    const unverified = mapUserToKeycloak(
      row({ emailVerified: false, phoneNumberVerified: false })
    );
    expect(unverified.ok && unverified.user.emailVerified).toBe(false);
    expect(unverified.ok && unverified.user.attributes.phoneNumberVerified).toEqual([
      'false',
    ]);
  });

  it('treats a null phoneNumberVerified as unverified, not as verified', () => {
    const result = mapUserToKeycloak(row({ phoneNumberVerified: null }));
    expect(result.ok && result.user.attributes.phoneNumberVerified).toEqual(['false']);
  });

  it('disables a banned user and keeps the ban reason auditable', () => {
    // R8: a banned user migrates disabled, so Keycloak will not mint a token
    // for them in the first place.
    const expires = new Date('2027-01-01T00:00:00.000Z');
    const result = mapUserToKeycloak(
      row({ banned: true, banReason: 'Spam', banExpires: expires })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.enabled).toBe(false);
    expect(result.user.attributes.banReason).toEqual(['Spam']);
    expect(result.user.attributes.banExpires).toEqual([expires.toISOString()]);
  });

  it('omits ban attributes for a user who is not banned', () => {
    const result = mapUserToKeycloak(row({ banReason: 'stale leftover' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.enabled).toBe(true);
    expect(result.user.attributes).not.toHaveProperty('banReason');
  });

  it('handles a phone-only user', () => {
    const result = mapUserToKeycloak(row({ email: null, emailVerified: false }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.username).toBe('+919876543210');
    expect(result.user).not.toHaveProperty('email');
    expect(result.user.emailVerified).toBe(false);
  });

  it('handles an email-only user', () => {
    const result = mapUserToKeycloak(row({ phoneNumber: null, phoneNumberVerified: null }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.attributes).not.toHaveProperty('phoneNumber');
  });

  it('never claims emailVerified for a user with no email', () => {
    const result = mapUserToKeycloak(row({ email: null, emailVerified: true }));
    expect(result.ok && result.user.emailVerified).toBe(false);
  });

  it('maps an admin to the admin realm role', () => {
    const result = mapUserToKeycloak(row({ role: 'admin' }));
    expect(result.ok && result.user.realmRoles).toEqual([SIGNALS_ADMIN_ROLE]);
  });

  it('refuses a row with neither email nor phone', () => {
    // Cannot log in via OTP; almost certainly bad data worth an operator's eyes
    // rather than a silently-created shell.
    const result = mapUserToKeycloak(row({ email: null, phoneNumber: null }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_IDENTIFIER');
  });

  it('refuses a row with no id', () => {
    const result = mapUserToKeycloak(row({ id: '   ' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_ID');
  });

  it('tolerates an empty name without inventing one', () => {
    const result = mapUserToKeycloak(row({ name: '' }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user).not.toHaveProperty('firstName');
    expect(result.user).not.toHaveProperty('lastName');
  });
});
