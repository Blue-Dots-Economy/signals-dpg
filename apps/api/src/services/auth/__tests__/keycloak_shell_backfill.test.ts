import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * The JIT safety net (§6.2): giving a straggler a Keycloak shell, keyed on
 * their existing UUID, at the one moment signals can still do it — when they
 * log in the old way during the `dual` window.
 *
 * The properties under test are all about restraint: it must be a no-op outside
 * `dual`, must never fail a login that already succeeded, and must never leave
 * behind an identity whose id doesn't match the local row.
 */

const dbState = { rows: [] as unknown[], selectError: null as unknown };

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => {
          if (dbState.selectError) throw dbState.selectError;
          return dbState.rows;
        } }),
      }),
    }),
    insert: () => ({ values: async () => {} }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  },
}));

const mockAuthConfig = {
  provider: 'dual' as 'betterauth' | 'dual' | 'keycloak',
  allow_self_signup: true,
  login_channels: ['phone', 'email'] as Array<'phone' | 'email'>,
};

const mockKeycloakConfig = {
  internal_base_url: 'http://keycloak:8080',
  realm: 'bluedots',
  api_client_id: 'signals-api',
  api_client_secret: 'shh' as string | undefined,
};

vi.mock('@/config', () => ({
  authConfig: mockAuthConfig,
  keycloakConfig: mockKeycloakConfig,
}));

vi.mock('@/services/signup_guardian', () => ({
  materializeSignupGuardian: vi.fn(async () => {}),
}));

// provisioning.ts imports this, which reaches redis -> databasesConfig. Not
// under test here, so stub it rather than widening the @/config mock.
vi.mock('@/services/auth/signup_extras', () => ({
  takeSignupExtras: vi.fn(async () => null),
}));

const getUserById = vi.fn();
const createUserPreservingId = vi.fn();
const deleteUser = vi.fn(async () => {});
const attributesWillPersist = vi.fn(async () => true);

vi.mock('@/services/auth/keycloak_admin', () => ({
  KeycloakAdminClient: class {
    getUserById = getUserById;
    createUserPreservingId = createUserPreservingId;
    deleteUser = deleteUser;
    attributesWillPersist = attributesWillPersist;
  },
}));

const { backfillKeycloakShell, resetKeycloakShellBackfillState } = await import(
  '../provisioning.js'
);

const USER_ID = '11111111-2222-3333-4444-555555555555';

const USER_ROW = {
  id: USER_ID,
  name: 'Asha Rao',
  email: 'asha@example.org',
  emailVerified: true,
  phoneNumber: '+919876543210',
  phoneNumberVerified: true,
  role: 'user',
  banned: false,
  banReason: null,
  banExpires: null,
};

const makeLog = () =>
  ({
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }) as unknown as FastifyBaseLogger;

beforeEach(() => {
  resetKeycloakShellBackfillState();
  dbState.rows = [USER_ROW];
  dbState.selectError = null;
  mockAuthConfig.provider = 'dual';
  mockKeycloakConfig.api_client_secret = 'shh';
  mockKeycloakConfig.internal_base_url = 'http://keycloak:8080';
  getUserById.mockReset().mockResolvedValue(null);
  createUserPreservingId.mockReset().mockResolvedValue({ kind: 'created' });
  deleteUser.mockReset().mockResolvedValue(undefined);
  attributesWillPersist.mockReset().mockResolvedValue(true);
});

describe('provider gating', () => {
  it('is a no-op under betterauth — there is nothing to backfill into', async () => {
    mockAuthConfig.provider = 'betterauth';

    await backfillKeycloakShell(USER_ID, makeLog());

    expect(getUserById).not.toHaveBeenCalled();
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('is a no-op under keycloak — the old login path no longer runs', async () => {
    mockAuthConfig.provider = 'keycloak';

    await backfillKeycloakShell(USER_ID, makeLog());

    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('runs under dual', async () => {
    await backfillKeycloakShell(USER_ID, makeLog());

    expect(createUserPreservingId).toHaveBeenCalledOnce();
  });

  it('stays disabled, with one warning, when no admin secret is configured', async () => {
    mockKeycloakConfig.api_client_secret = undefined;
    const log = makeLog();

    await backfillKeycloakShell(USER_ID, log);
    await backfillKeycloakShell('another-user', log);

    expect(createUserPreservingId).not.toHaveBeenCalled();
    // Warned, but not once per login.
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});

describe('backfill behaviour', () => {
  it('creates the shell with the local user id preserved', async () => {
    await backfillKeycloakShell(USER_ID, makeLog());

    expect(createUserPreservingId).toHaveBeenCalledOnce();
    const [representation] = createUserPreservingId.mock.calls[0];
    expect(representation.id).toBe(USER_ID);
    expect(representation.username).toBe('asha@example.org');
  });

  it('does nothing when the user already has a Keycloak account', async () => {
    getUserById.mockResolvedValue({ id: USER_ID });

    await backfillKeycloakShell(USER_ID, makeLog());

    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('only attempts once per user per process', async () => {
    const log = makeLog();

    await backfillKeycloakShell(USER_ID, log);
    await backfillKeycloakShell(USER_ID, log);
    await backfillKeycloakShell(USER_ID, log);

    // A returning user must not cost a Keycloak round-trip on every request.
    expect(getUserById).toHaveBeenCalledTimes(1);
    expect(createUserPreservingId).toHaveBeenCalledTimes(1);
  });

  it('skips a user row that cannot be mapped', async () => {
    dbState.rows = [{ ...USER_ROW, email: null, phoneNumber: null }];
    const log = makeLog();

    await backfillKeycloakShell(USER_ID, log);

    expect(createUserPreservingId).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalled();
  });

  it('does nothing when the local row has vanished', async () => {
    dbState.rows = [];

    await backfillKeycloakShell(USER_ID, makeLog());

    expect(createUserPreservingId).not.toHaveBeenCalled();
  });
});

describe('failure handling — a succeeded login must never be broken', () => {
  it('swallows a Keycloak outage', async () => {
    getUserById.mockRejectedValue(new Error('ECONNREFUSED'));
    const log = makeLog();

    await expect(backfillKeycloakShell(USER_ID, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('swallows a database failure', async () => {
    dbState.selectError = new Error('connection reset');
    const log = makeLog();

    await expect(backfillKeycloakShell(USER_ID, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('logs an identifier conflict without throwing', async () => {
    createUserPreservingId.mockResolvedValue({ kind: 'conflict', detail: 'User exists with same email' });
    const log = makeLog();

    await expect(backfillKeycloakShell(USER_ID, log)).resolves.toBeUndefined();
    expect(log.error).toHaveBeenCalled();
  });

  it('deletes a wrongly-keyed user when the UUID was not preserved', async () => {
    // If Keycloak assigns its own id, leaving that user behind would mean an
    // identity whose sub matches no local row. Remove it and shout.
    createUserPreservingId.mockResolvedValue({
      kind: 'created_with_different_id',
      assignedId: 'kc-generated-id',
    });
    const log = makeLog();

    await backfillKeycloakShell(USER_ID, log);

    expect(deleteUser).toHaveBeenCalledWith('kc-generated-id');
    expect(log.error).toHaveBeenCalled();
  });

  it('treats an already-existing user as success, not an error', async () => {
    createUserPreservingId.mockResolvedValue({ kind: 'already_exists' });
    const log = makeLog();

    await backfillKeycloakShell(USER_ID, log);

    expect(log.error).not.toHaveBeenCalled();
  });
});

describe('UUID preservation — the regression that broke Path A', () => {
  it('creates via the id-preserving path, never plain POST /users', async () => {
    // KC 26.5.5's POST /users mints its own id, which would break
    // sub == user.id. The bulk script learned this; the JIT path originally
    // did not, so every backfill self-aborted with "did NOT preserve the UUID".
    await backfillKeycloakShell(USER_ID, makeLog());

    expect(createUserPreservingId).toHaveBeenCalledOnce();
    expect(createUserPreservingId.mock.calls[0][0].id).toBe(USER_ID);
  });

  it('refuses to write anything when the realm would drop phone attributes', async () => {
    // Otherwise the user is created but can never receive a phone OTP, with
    // nothing in any log to explain it.
    attributesWillPersist.mockResolvedValue(false);
    const log = makeLog();

    await backfillKeycloakShell(USER_ID, log);

    expect(createUserPreservingId).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('probes the realm profile only once per process', async () => {
    const log = makeLog();
    await backfillKeycloakShell(USER_ID, log);
    await backfillKeycloakShell('second-user', log);

    expect(attributesWillPersist).toHaveBeenCalledTimes(1);
  });
});
