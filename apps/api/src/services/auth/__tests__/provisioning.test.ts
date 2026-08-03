import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Unit coverage for the relocated `unified_otp` business logic (design §4, and
 * the "highest-value new coverage" §9 calls for): the self-signup gate, the
 * channel gate, guardian materialization, member/org-join, and — above all —
 * that the local mirror's primary key is always the Keycloak `sub`.
 */

// ── db fake ────────────────────────────────────────────────────────────────
// A per-table FIFO of scripted results. Provisioning selects from `user` twice
// on the create path (resolve-by-sub, then the identifier clash check), so
// results have to be ordered per table rather than matched on the predicate —
// drizzle's `where` clauses are opaque SQL objects, not inspectable filters.
const dbState = {
  selects: new Map<unknown, unknown[][]>(),
  inserted: [] as Array<{ table: unknown; values: Record<string, unknown> }>,
  updated: [] as Array<{ table: unknown; set: Record<string, unknown> }>,
  selectError: null as unknown,
  insertError: null as unknown,
  updateError: null as unknown,
};

function queueSelect(table: unknown, rows: unknown[]): void {
  const queue = dbState.selects.get(table) ?? [];
  queue.push(rows);
  dbState.selects.set(table, queue);
}

function nextSelect(table: unknown): unknown[] {
  return dbState.selects.get(table)?.shift() ?? [];
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: (table: unknown) => ({
        where: () => ({
          limit: async () => {
            if (dbState.selectError) throw dbState.selectError;
            return nextSelect(table);
          },
        }),
      }),
    }),
    insert: (table: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        if (dbState.insertError) throw dbState.insertError;
        dbState.inserted.push({ table, values });
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          if (dbState.updateError) throw dbState.updateError;
          dbState.updated.push({ table, set });
        },
      }),
    }),
  },
}));

// ── config fake ────────────────────────────────────────────────────────────
const mockAuthConfig = {
  allow_self_signup: true,
  login_channels: ['phone', 'email'] as Array<'phone' | 'email'>,
};

vi.mock('@/config', () => ({ authConfig: mockAuthConfig }));

const materializeSignupGuardian = vi.fn(async () => {});
vi.mock('@/services/signup_guardian', () => ({ materializeSignupGuardian }));

// Welcome email/WhatsApp for a genuinely-new user (G1). Mocked at the module
// seam rather than by widening the `@/config` fake, because the real one reaches
// for notification-service credentials this suite has no business knowing about.
const sendWelcomeNotifications = vi.fn(async () => {});
vi.mock('@/notifications/welcome', () => ({ sendWelcomeNotifications }));

// Signup extras parked by the Keycloak self-signup path.
const takeSignupExtras = vi.fn<() => Promise<{ domain?: string; age?: number } | null>>();
vi.mock('@/services/auth/signup_extras', () => ({
  takeSignupExtras: (...a: unknown[]) => takeSignupExtras(...(a as [])),
}));

const { provisionUserFromClaims } = await import('../provisioning.js');
const {
  user: userTable,
  organization: organizationTable,
  member: memberTable,
} = await import('@api/db/postgres/schema/auth');

// ── helpers ────────────────────────────────────────────────────────────────
const SUB = '11111111-2222-3333-4444-555555555555';

const makeLog = () =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }) as unknown as FastifyBaseLogger;

function claims(overrides: Record<string, unknown> = {}) {
  return {
    sub: SUB,
    iss: 'http://kc/realms/bluedots',
    aud: ['account'],
    azp: 'signals-ui',
    exp: 9999999999,
    email: 'asha@example.org',
    email_verified: true,
    ...overrides,
  } as Parameters<typeof provisionUserFromClaims>[0];
}

/** A local mirror row as it comes back from the db. */
function existingUser(overrides: Record<string, unknown> = {}) {
  return {
    id: SUB,
    name: 'Asha',
    email: 'asha@example.org',
    emailVerified: true,
    image: '',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    role: 'user',
    banned: false,
    banReason: '',
    banExpires: null,
    phoneNumber: null,
    phoneNumberVerified: null,
    age: null,
    domains: null,
    termsAccepted: true,
    privacyAccepted: true,
    onboardedByOrgId: null,
    onboardedVia: null,
    onboardedSourceId: null,
    onboardedAt: null,
    tags: {},
    ...overrides,
  };
}

const insertsInto = (table: unknown) => dbState.inserted.filter((i) => i.table === table);
const updatesTo = (table: unknown) => dbState.updated.filter((u) => u.table === table);

beforeEach(() => {
  dbState.selects.clear();
  dbState.inserted = [];
  dbState.updated = [];
  dbState.selectError = null;
  dbState.insertError = null;
  dbState.updateError = null;
  mockAuthConfig.allow_self_signup = true;
  mockAuthConfig.login_channels = ['phone', 'email'];
  materializeSignupGuardian.mockClear();
  materializeSignupGuardian.mockImplementation(async () => {});
  sendWelcomeNotifications.mockClear();
  sendWelcomeNotifications.mockImplementation(async () => {});
  takeSignupExtras.mockReset().mockResolvedValue(null);
});

// ───────────────────────────────────────────────────────────────────────────

describe('first login — creating the mirror', () => {
  it('creates the local user with id == sub, the linchpin of the whole design', async () => {
    queueSelect(userTable, []); // no row for this sub
    queueSelect(userTable, []); // no identifier clash

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(true);
    expect(result.user.id).toBe(SUB);

    const [insert] = insertsInto(userTable);
    // If this ever stops being `sub`, every items.created_by / *_owner column
    // silently stops matching the identity that owns it.
    expect(insert.values.id).toBe(SUB);
    expect(insert.values.email).toBe('asha@example.org');
    expect(insert.values.emailVerified).toBe(true);
  });

  it('carries the verified flags and defaults across from the token', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    await provisionUserFromClaims(
      claims({
        email: undefined,
        email_verified: false,
        phone_number: '+911234567890',
        phone_number_verified: true,
        name: 'Asha Rao',
      }),
      makeLog()
    );

    const [insert] = insertsInto(userTable);
    expect(insert.values.phoneNumber).toBe('+911234567890');
    expect(insert.values.phoneNumberVerified).toBe(true);
    expect(insert.values.name).toBe('Asha Rao');
    // Parity with unified_otp's create.
    expect(insert.values.termsAccepted).toBe(true);
    expect(insert.values.privacyAccepted).toBe(true);
    expect(insert.values.role).toBe('user');
    expect(insert.values.banned).toBe(false);
    // Age is captured post-login or by guardian materialization, never guessed.
    expect(insert.values.age).toBeUndefined();
  });

  it('accepts phone_number_verified as the string Keycloak attributes produce', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    await provisionUserFromClaims(
      claims({ phone_number: '+911234567890', phone_number_verified: 'true' }),
      makeLog()
    );

    expect(insertsInto(userTable)[0].values.phoneNumberVerified).toBe(true);
  });

  it('builds a name from given_name/family_name when there is no name claim', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    await provisionUserFromClaims(
      claims({ given_name: 'Asha', family_name: 'Rao' }),
      makeLog()
    );

    expect(insertsInto(userTable)[0].values.name).toBe('Asha Rao');
  });

  it("falls back to 'user' when the token carries no name at all", async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    await provisionUserFromClaims(claims(), makeLog());

    expect(insertsInto(userTable)[0].values.name).toBe('user');
  });
});

describe('self-signup gate (R2) — the gate must not reopen at the Keycloak layer', () => {
  it('refuses to create a mirror when SELF_SIGNUP_MODE=gated', async () => {
    mockAuthConfig.allow_self_signup = false;
    queueSelect(userTable, []); // valid token, but no local row

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SELF_SIGNUP_DISABLED');
    // Nothing written — the whole point.
    expect(dbState.inserted).toHaveLength(0);
  });

  it('still logs in an admin-onboarded participant when gated', async () => {
    // The admin path already created both the Keycloak user and the local row,
    // so a gated instance must not lock them out.
    mockAuthConfig.allow_self_signup = false;
    queueSelect(userTable, [existingUser()]);

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.user.id).toBe(SUB);
  });

  it('creates the mirror when SELF_SIGNUP_MODE=allowed', async () => {
    mockAuthConfig.allow_self_signup = true;
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
    expect(insertsInto(userTable)).toHaveLength(1);
  });
});

describe('channel gate (LOGIN_CHANNELS)', () => {
  it('rejects a phone-only user on an email-only instance', async () => {
    // Open question 9(b): an instance with no SMS provider. Failing here with a
    // clear code beats half-provisioning an account that can never log in.
    mockAuthConfig.login_channels = ['email'];

    const result = await provisionUserFromClaims(
      claims({ email: undefined, phone_number: '+911234567890' }),
      makeLog()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LOGIN_CHANNEL_DISABLED');
    expect(dbState.inserted).toHaveLength(0);
  });

  it('rejects an email-only user on a phone-only instance', async () => {
    mockAuthConfig.login_channels = ['phone'];

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LOGIN_CHANNEL_DISABLED');
  });

  it('allows a user who has any identifier on an enabled channel', async () => {
    mockAuthConfig.login_channels = ['email'];
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    const result = await provisionUserFromClaims(
      claims({ phone_number: '+911234567890' }),
      makeLog()
    );

    expect(result.ok).toBe(true);
  });

  it('rejects a token carrying no identifier at all', async () => {
    const result = await provisionUserFromClaims(
      claims({ email: undefined }),
      makeLog()
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_IDENTIFIER');
  });

  it('runs the channel gate before touching the database', async () => {
    mockAuthConfig.login_channels = ['phone'];
    dbState.selectError = new Error('db must not be reached');

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LOGIN_CHANNEL_DISABLED');
  });
});

describe('bans (R8)', () => {
  it('refuses a banned user and surfaces the reason', async () => {
    queueSelect(userTable, [existingUser({ banned: true, banReason: 'Spam' })]);

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('USER_BANNED');
    expect(result.message).toBe('Spam');
  });

  it('falls back to a generic message when no ban reason is recorded', async () => {
    queueSelect(userTable, [existingUser({ banned: true, banReason: '' })]);

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('suspended');
  });
});

describe('mirror refresh — Keycloak is authoritative for identity claims', () => {
  it('is a no-op when nothing changed', async () => {
    queueSelect(userTable, [existingUser()]);

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
    expect(updatesTo(userTable)).toHaveLength(0);
  });

  it('propagates a changed email and a newly-verified phone', async () => {
    queueSelect(userTable, [
      existingUser({ phoneNumber: '+911234567890', phoneNumberVerified: false }),
    ]);

    await provisionUserFromClaims(
      claims({
        email: 'asha.rao@example.org',
        phone_number: '+911234567890',
        phone_number_verified: true,
      }),
      makeLog()
    );

    const [update] = updatesTo(userTable);
    expect(update.set.email).toBe('asha.rao@example.org');
    expect(update.set.phoneNumberVerified).toBe(true);
  });

  it('never touches signals-owned columns', async () => {
    // The ownership split (§6.1) only works if these stay local. A refresh that
    // reached them would quietly erase onboarding attribution and ops markers.
    queueSelect(userTable, [existingUser({ email: 'old@example.org' })]);

    await provisionUserFromClaims(claims(), makeLog());

    const [update] = updatesTo(userTable);
    for (const column of [
      'domains',
      'age',
      'tags',
      'onboardedByOrgId',
      'onboardedVia',
      'onboardedSourceId',
      'onboardedAt',
      'termsAccepted',
      'privacyAccepted',
    ]) {
      expect(update.set).not.toHaveProperty(column);
    }
  });

  it('does not stomp a real local name with Keycloak’s placeholder', async () => {
    queueSelect(userTable, [existingUser({ name: 'Asha Rao' })]);

    await provisionUserFromClaims(claims({ name: undefined }), makeLog());

    expect(updatesTo(userTable)).toHaveLength(0);
  });

  it('fills in a placeholder name once the token carries a real one', async () => {
    queueSelect(userTable, [existingUser({ name: 'user' })]);

    await provisionUserFromClaims(claims({ name: 'Asha Rao' }), makeLog());

    expect(updatesTo(userTable)[0].set.name).toBe('Asha Rao');
  });

  it('does not sync role from the token — that would demote existing admins', async () => {
    queueSelect(userTable, [existingUser({ role: 'admin' })]);

    const result = await provisionUserFromClaims(
      claims({ realm_access: { roles: ['signals_participant'] } }),
      makeLog()
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.user.role).toBe('admin');
    expect(updatesTo(userTable)).toHaveLength(0);
  });
});

describe('identity conflicts — never merge, never rekey', () => {
  it('refuses when another local user already holds the token’s identifiers', async () => {
    // §6.3 spike 2: the same human already exists in the realm under a
    // different sub. Rewriting the local id is exactly what this design forbids.
    queueSelect(userTable, []); // nothing for this sub
    queueSelect(userTable, [{ id: 'a-different-user-id' }]); // but the email is taken

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('IDENTITY_CONFLICT');
    expect(dbState.inserted).toHaveLength(0);
  });

  it('reports a unique violation on refresh as a conflict, not a 500', async () => {
    queueSelect(userTable, [existingUser({ email: 'old@example.org' })]);
    dbState.updateError = Object.assign(new Error('duplicate key'), { code: '23505' });

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('IDENTITY_CONFLICT');
  });

  it('recovers from a concurrent first login by re-reading the winner', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    dbState.insertError = Object.assign(new Error('duplicate key'), { code: '23505' });
    queueSelect(userTable, [existingUser()]); // the racing request's row

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.created).toBe(false);
    expect(result.user.id).toBe(SUB);
  });
});

describe('guardian materialization (U18)', () => {
  it('runs for a genuinely new user, keyed on the signup identifiers', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    await provisionUserFromClaims(
      claims({ phone_number: '+911234567890' }),
      makeLog()
    );

    expect(materializeSignupGuardian).toHaveBeenCalledWith({
      id: SUB,
      email: 'asha@example.org',
      phoneNumber: '+911234567890',
    });
  });

  it('does not run for a returning user', async () => {
    queueSelect(userTable, [existingUser()]);

    await provisionUserFromClaims(claims(), makeLog());

    expect(materializeSignupGuardian).not.toHaveBeenCalled();
  });

  it('never blocks the login when it fails', async () => {
    // Same contract as the better-auth afterUserCreate hook it replaces: a
    // half-captured guardian record must not lock a ward out of their account.
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    materializeSignupGuardian.mockRejectedValueOnce(new Error('consent versions missing'));
    const log = makeLog();

    const result = await provisionUserFromClaims(claims(), log);

    expect(result.ok).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });
});

describe('welcome notifications (G1 — the other half of afterUserCreate)', () => {
  it('sends the welcome for a genuinely-new user, addressed by both identifiers', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    await provisionUserFromClaims(
      claims({ phone_number: '+911234567890' }),
      makeLog()
    );

    expect(sendWelcomeNotifications).toHaveBeenCalledTimes(1);
    const [recipient] = sendWelcomeNotifications.mock.calls[0] as unknown as [
      { name: string; email: string | null; phoneNumber: string | null },
    ];
    expect(recipient.email).toBe('asha@example.org');
    expect(recipient.phoneNumber).toBe('+911234567890');
    expect(recipient.name).toBeTruthy();
  });

  it('does not re-send for a returning user', async () => {
    // The whole point of it living in createMirror: a welcome message on every
    // login would be spam.
    queueSelect(userTable, [existingUser()]);

    await provisionUserFromClaims(claims(), makeLog());

    expect(sendWelcomeNotifications).not.toHaveBeenCalled();
  });

  it('runs even when guardian materialization failed', async () => {
    // The two are independent best-effort steps; one failing must not silently
    // swallow the other.
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    materializeSignupGuardian.mockRejectedValueOnce(new Error('boom'));

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
    expect(sendWelcomeNotifications).toHaveBeenCalledTimes(1);
  });

  it('never blocks the login when it throws', async () => {
    // Defence in depth: the real implementation swallows per-channel failures,
    // but provisioning must survive it throwing anyway.
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    sendWelcomeNotifications.mockRejectedValueOnce(new Error('notify down'));

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
  });
});

describe('org membership (the relocated joinOrg branch)', () => {
  it('creates the member row when the token names an org', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    queueSelect(organizationTable, [{ id: 'org_1' }]);
    queueSelect(memberTable, []);

    await provisionUserFromClaims(
      claims({ signals_acting_orgs: 'org_1' }),
      makeLog()
    );

    const [insert] = insertsInto(memberTable);
    expect(insert.values.organizationId).toBe('org_1');
    expect(insert.values.userId).toBe(SUB);
    expect(insert.values.role).toBe('member');
  });

  it('is idempotent — no duplicate member row on a later login', async () => {
    queueSelect(userTable, [existingUser()]);
    queueSelect(organizationTable, [{ id: 'org_1' }]);
    queueSelect(memberTable, [{ id: 'member_1' }]);

    await provisionUserFromClaims(claims({ signals_acting_orgs: 'org_1' }), makeLog());

    expect(insertsInto(memberTable)).toHaveLength(0);
  });

  it('skips silently when the token names no org', async () => {
    queueSelect(userTable, [existingUser()]);

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(true);
    expect(insertsInto(memberTable)).toHaveLength(0);
  });

  it('warns but still logs the user in when the org is unknown locally', async () => {
    queueSelect(userTable, [existingUser()]);
    queueSelect(organizationTable, []);
    const log = makeLog();

    const result = await provisionUserFromClaims(
      claims({ signals_acting_orgs: 'org_missing' }),
      log
    );

    expect(result.ok).toBe(true);
    expect(log.warn).toHaveBeenCalled();
    expect(insertsInto(memberTable)).toHaveLength(0);
  });

  it('never fails the login when the member insert blows up', async () => {
    queueSelect(userTable, [existingUser()]);
    queueSelect(organizationTable, [{ id: 'org_1' }]);
    queueSelect(memberTable, []);
    dbState.insertError = new Error('member insert exploded');
    const log = makeLog();

    const result = await provisionUserFromClaims(
      claims({ signals_acting_orgs: 'org_1' }),
      log
    );

    expect(result.ok).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });

  // ── G5: the grant is read, and it is not the same thing as membership ────
  //
  // These pin the claim NAME as much as the behaviour. The previous code read a
  // `signalstack_org_id` claim that no client emits — the `signals-ui` mapper
  // reads that *user attribute* but emits it as `signals_acting_orgs` — so
  // `ensureOrgMembership` silently never ran. A test asserting the old name
  // passed while the feature was dead, which is what these replace.

  it('ignores a wildcard grant rather than joining every org', async () => {
    // `['*']` is the platform service grant: "may act for any org". Treating it
    // as membership would join the user to whatever org happened to be found.
    queueSelect(userTable, [existingUser()]);

    const result = await provisionUserFromClaims(claims({ signals_acting_orgs: '*' }), makeLog());

    expect(result.ok).toBe(true);
    expect(insertsInto(memberTable)).toHaveLength(0);
  });

  it('ignores a multi-org grant, which says what a caller may act for', async () => {
    // Two orgs is an authorisation grant, not a statement of membership; there
    // is no principled way to pick one.
    queueSelect(userTable, [existingUser()]);

    const result = await provisionUserFromClaims(
      claims({ signals_acting_orgs: 'org_1,org_2' }),
      makeLog()
    );

    expect(result.ok).toBe(true);
    expect(insertsInto(memberTable)).toHaveLength(0);
  });

  it('accepts a single concrete org, which for a human IS their org', async () => {
    // Design §5.1: a human's grant is sourced from their own
    // `signalstack_org_id` user attribute, so a single value is their org.
    queueSelect(userTable, [existingUser()]);
    queueSelect(organizationTable, [{ id: 'org_1' }]);
    queueSelect(memberTable, []);

    await provisionUserFromClaims(claims({ signals_acting_orgs: ' org_1 ' }), makeLog());

    const [insert] = insertsInto(memberTable);
    expect(insert.values.organizationId).toBe('org_1');
  });

  it('ignores an empty grant', async () => {
    queueSelect(userTable, [existingUser()]);

    const result = await provisionUserFromClaims(claims({ signals_acting_orgs: '' }), makeLog());

    expect(result.ok).toBe(true);
    expect(insertsInto(memberTable)).toHaveLength(0);
  });
});

describe('database failures', () => {
  it('reports a failed mirror read as PROVISIONING_FAILED', async () => {
    dbState.selectError = new Error('connection reset');
    const log = makeLog();

    const result = await provisionUserFromClaims(claims(), log);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVISIONING_FAILED');
    expect(log.error).toHaveBeenCalled();
  });

  it('reports a failed insert as PROVISIONING_FAILED', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    dbState.insertError = new Error('disk full');

    const result = await provisionUserFromClaims(claims(), makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('PROVISIONING_FAILED');
  });
});

describe('parked signup details (Keycloak self-signup)', () => {
  it('applies the domain and age onto the new mirror row', async () => {
    // The Keycloak signup path creates the identity before the local row exists,
    // so `domains` and age are parked against the identifier until first login.
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    takeSignupExtras.mockResolvedValue({ domain: 'seeker', age: 20 });

    await provisionUserFromClaims(claims(), makeLog());

    const update = updatesTo(userTable).at(-1);
    expect(update?.set.domains).toEqual(['seeker']);
    expect(update?.set.age).toBe(20);
  });

  it('is a no-op for a user with nothing parked (migrated / admin-onboarded)', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);

    await provisionUserFromClaims(claims(), makeLog());

    expect(updatesTo(userTable)).toHaveLength(0);
  });

  it('applies the stash BEFORE guardian materialization', async () => {
    // For a gated minor the guardian capture is the OTP-verified record and must
    // win on age, so it has to run second.
    const order: string[] = [];
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    takeSignupExtras.mockImplementation(async () => {
      order.push('extras');
      return { age: 20 };
    });
    materializeSignupGuardian.mockImplementation(async () => {
      order.push('guardian');
    });

    await provisionUserFromClaims(claims(), makeLog());

    expect(order).toEqual(['extras', 'guardian']);
  });

  it('never fails the login when the stash read blows up', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    takeSignupExtras.mockRejectedValue(new Error('redis down'));
    const log = makeLog();

    const result = await provisionUserFromClaims(claims(), log);

    expect(result.ok).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });

  it('ignores a non-numeric stashed age rather than writing garbage', async () => {
    queueSelect(userTable, []);
    queueSelect(userTable, []);
    takeSignupExtras.mockResolvedValue({
      age: 'not-a-number' as unknown as number,
    });

    await provisionUserFromClaims(claims(), makeLog());

    expect(updatesTo(userTable)).toHaveLength(0);
  });
});
