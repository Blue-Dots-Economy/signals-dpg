import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Self-signup under Keycloak. The gates matter most: a gated instance must not
 * create anything, and no local `user` row may be written before the person has
 * proved they own the identifier via OTP.
 */

const dbState = { rows: [] as unknown[], selectError: null as unknown };
const inserted: unknown[] = [];

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if (dbState.selectError) throw dbState.selectError;
            return dbState.rows;
          },
        }),
      }),
    }),
    insert: () => ({ values: async (v: unknown) => { inserted.push(v); } }),
  },
}));

// `expires` records (key, ttl) so tests can assert the configured window reaches
// Redis, and that no per-IP key is ever written.
const redisState = {
  counts: new Map<string, number>(),
  expires: [] as Array<{ key: string; ttl: number }>,
  error: null as unknown,
};
vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    incr: async (key: string) => {
      if (redisState.error) throw redisState.error;
      const next = (redisState.counts.get(key) ?? 0) + 1;
      redisState.counts.set(key, next);
      return next;
    },
    expire: async (key: string, ttl: number) => {
      redisState.expires.push({ key, ttl });
      return 1;
    },
  },
}));

const mockAuthConfig = {
  keycloak_enabled: true,
  allow_self_signup: true,
  login_channels: ['phone', 'email'] as Array<'phone' | 'email'>,
  // Mirrors the SIGNUP_* env defaults; the throttle reads these per request.
  signup_rate_limit: {
    window_seconds: 3600,
    max_per_identifier: 3,
  },
};
const mockKeycloakConfig = {
  internal_base_url: 'http://keycloak:8080',
  realm: 'bluedots',
  api_client_id: 'signals-api',
  api_client_secret: 'shh' as string | undefined,
};
const mockApiConfig = {
  served_domains: [{ domain: 'student' }, { domain: 'employer' }],
};
vi.mock('@/config', () => ({
  apiConfig: mockApiConfig,
  authConfig: mockAuthConfig,
  keycloakConfig: mockKeycloakConfig,
}));

const findByEmail = vi.fn(async () => [] as Array<{ id: string }>);
const findByPhone = vi.fn(async () => [] as Array<{ id: string }>);
type Rep = {
  id: string;
  email?: string;
  emailVerified: boolean;
  attributes: Record<string, string[]>;
};
const createUserPreservingId =
  vi.fn<(user: Rep) => Promise<{ kind: string; detail?: string }>>();
const attributesWillPersist = vi.fn(async (_attribute: string) => true);

vi.mock('@/services/auth/keycloak_admin', () => ({
  KeycloakAdminClient: class {
    findByEmail = findByEmail;
    findByPhone = findByPhone;
    createUserPreservingId = createUserPreservingId;
    attributesWillPersist = attributesWillPersist;
  },
}));

const { selfSignup, resetSelfSignupState } = await import('../self_signup.js');

const makeLog = () =>
  ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) as unknown as FastifyBaseLogger;

const INPUT = { name: 'Asha Rao', email: 'asha@example.org', clientIp: '10.0.0.1' };

beforeEach(() => {
  resetSelfSignupState();
  dbState.rows = [];
  dbState.selectError = null;
  inserted.length = 0;
  redisState.counts.clear();
  redisState.expires.length = 0;
  redisState.error = null;
  mockAuthConfig.keycloak_enabled = true;
  mockAuthConfig.allow_self_signup = true;
  mockAuthConfig.login_channels = ['phone', 'email'];
  // Mutated in place by the tunability tests below, so it must be reset here.
  mockAuthConfig.signup_rate_limit = {
    window_seconds: 3600,
    max_per_identifier: 3,
  };
  mockKeycloakConfig.api_client_secret = 'shh';
  mockApiConfig.served_domains = [{ domain: 'student' }, { domain: 'employer' }];
  findByEmail.mockReset().mockResolvedValue([]);
  findByPhone.mockReset().mockResolvedValue([]);
  createUserPreservingId.mockReset().mockResolvedValue({ kind: 'created' });
  attributesWillPersist.mockReset().mockResolvedValue(true);
});

describe('gates', () => {
  it('refuses when self-signup is gated (R2)', async () => {
    mockAuthConfig.allow_self_signup = false;

    const result = await selfSignup(INPUT, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SELF_SIGNUP_DISABLED');
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('refuses on a better-auth instance — the old flow owns signup there', async () => {
    mockAuthConfig.keycloak_enabled = false;

    const result = await selfSignup(INPUT, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_NOT_AVAILABLE');
  });

  it('refuses with no identifier', async () => {
    const result = await selfSignup({ name: 'Asha' }, makeLog());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('NO_IDENTIFIER');
  });

  it('refuses an identifier on a disabled channel', async () => {
    mockAuthConfig.login_channels = ['phone'];

    const result = await selfSignup(INPUT, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('LOGIN_CHANNEL_DISABLED');
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('refuses when no admin secret is configured', async () => {
    mockKeycloakConfig.api_client_secret = undefined;

    const result = await selfSignup(INPUT, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_NOT_AVAILABLE');
  });
});

describe('creating the identity', () => {
  it('creates a Keycloak user and NO local user row', async () => {
    // The local mirror is created at first login, once OTP has proved the person
    // owns the identifier. An abandoned signup must leave no signals user.
    const result = await selfSignup(INPUT, makeLog());

    expect(result).toEqual({ ok: true, alreadyRegistered: false });
    expect(createUserPreservingId).toHaveBeenCalledOnce();
    expect(inserted).toHaveLength(0);
  });

  it('mints a UUID that will become the local user.id', async () => {
    await selfSignup(INPUT, makeLog());

    const [rep] = createUserPreservingId.mock.calls[0];
    expect(rep.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('marks the identifier unverified — OTP login is what verifies it', async () => {
    await selfSignup({ ...INPUT, phoneNumber: '+919876500001' }, makeLog());

    const [rep] = createUserPreservingId.mock.calls[0];
    expect(rep.emailVerified).toBe(false);
    expect(rep.attributes.phoneNumberVerified).toEqual(['false']);
  });

  it('normalises the email before creating', async () => {
    await selfSignup({ ...INPUT, email: '  Asha@Example.ORG ' }, makeLog());

    const [rep] = createUserPreservingId.mock.calls[0];
    expect(rep.email).toBe('asha@example.org');
  });

  it('goes through the id-preserving path, never plain create', async () => {
    await selfSignup(INPUT, makeLog());
    // createUser (POST /users) is not even stubbed — using it would throw.
    expect(createUserPreservingId).toHaveBeenCalled();
  });
});

describe('existing identifiers — never duplicate a person', () => {
  it('reports alreadyRegistered when a local signals user holds it', async () => {
    dbState.rows = [{ id: 'existing-local-id' }];

    const result = await selfSignup(INPUT, makeLog());

    expect(result).toEqual({ ok: true, alreadyRegistered: true });
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('reports alreadyRegistered when the realm already holds it', async () => {
    // e.g. an aggregator user in the shared realm, or an earlier signup that
    // never completed its first login.
    findByEmail.mockResolvedValue([{ id: 'kc-user' }]);

    const result = await selfSignup(INPUT, makeLog());

    expect(result).toEqual({ ok: true, alreadyRegistered: true });
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('treats a create-time conflict as already registered when a re-check finds the identifier', async () => {
    // The honest race: someone claimed the identifier between the pre-check and
    // the create.
    createUserPreservingId.mockResolvedValue({ kind: 'conflict', detail: 'taken' });
    findByEmail.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: 'kc-racer' }]);

    const result = await selfSignup(INPUT, makeLog());

    expect(result).toEqual({ ok: true, alreadyRegistered: true });
  });

  it('reports SIGNUP_FAILED when the identity was neither created nor found', async () => {
    // Answering `alreadyRegistered` here is the "sign-up says registered /
    // sign-in says no such user" dead-end this migration exists to remove: the
    // person is told to log in to an account that does not exist, with no way out.
    createUserPreservingId.mockResolvedValue({ kind: 'conflict', detail: 'partialImport added=0' });
    const log = makeLog();

    const result = await selfSignup(INPUT, log);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_FAILED');
    expect(log.error).toHaveBeenCalled();
  });
});

describe('domain and age validation', () => {
  it('refuses a domain this instance does not serve', async () => {
    // A real authorization check, not input hygiene: `domains` gates profile
    // creation downstream (user_domains.ts).
    const result = await selfSignup({ ...INPUT, domain: 'astronaut' }, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DOMAIN_NOT_SERVED');
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('accepts a served domain', async () => {
    const result = await selfSignup({ ...INPUT, domain: 'student' }, makeLog());

    expect(result).toEqual({ ok: true, alreadyRegistered: false });
  });

  it.each([-1, 121, 12.5])('refuses age %s', async (age) => {
    const result = await selfSignup({ ...INPUT, age }, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_AGE');
    expect(createUserPreservingId).not.toHaveBeenCalled();
  });

  it('accepts an age within range', async () => {
    const result = await selfSignup({ ...INPUT, age: 17 }, makeLog());
    expect(result.ok).toBe(true);
  });
});

describe('phone attributes must actually persist', () => {
  it('refuses a phone signup when the realm drops the phoneNumber attribute', async () => {
    // Otherwise the account is created and can never receive an OTP — the same
    // false green the migration script already guards against.
    attributesWillPersist.mockResolvedValue(false);
    const log = makeLog();

    const result = await selfSignup(
      { name: 'Asha', phoneNumber: '+919876500001', clientIp: '10.0.0.1' },
      log
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_NOT_AVAILABLE');
    expect(createUserPreservingId).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  });

  it('does not probe the realm profile for an email-only signup', async () => {
    await selfSignup(INPUT, makeLog());

    expect(attributesWillPersist).not.toHaveBeenCalled();
    expect(createUserPreservingId).toHaveBeenCalled();
  });

  it('probes once per process, not once per signup', async () => {
    await selfSignup({ name: 'A', phoneNumber: '+919876500001' }, makeLog());
    await selfSignup({ name: 'B', phoneNumber: '+919876500002' }, makeLog());

    expect(attributesWillPersist).toHaveBeenCalledOnce();
  });
});

describe('rate limiting', () => {
  it('blocks a fourth attempt on the same identifier', async () => {
    for (let i = 0; i < 3; i += 1) {
      expect((await selfSignup(INPUT, makeLog())).ok).toBe(true);
    }

    const result = await selfSignup(INPUT, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_RATE_LIMITED');
  });

  // Rotating the identifier defeats the per-identifier counter (each address is a
  // fresh key at count 1), so this is the case the per-IP ceiling exists for.
  it('blocks bulk signup from one IP across different identifiers', async () => {
    for (let i = 0; i < 10; i += 1) {
      const res = await selfSignup({ ...INPUT, email: `user${i}@example.org` }, makeLog());
      expect(res.ok).toBe(true);
    }

    const result = await selfSignup({ ...INPUT, email: 'eleventh@example.org' }, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_RATE_LIMITED');
  });

  // Separate windows on purpose: retuning the identifier window to release
  // someone must not also loosen the abuse ceiling.
  it('keeps the per-IP ceiling on its own window, not the tunable one', async () => {
    mockAuthConfig.signup_rate_limit.window_seconds = 60;

    await selfSignup(INPUT, makeLog());

    expect(redisState.expires).toEqual([
      { key: `signup:id:${INPUT.email}`, ttl: 60 },
      { key: `signup:ip:${INPUT.clientIp}`, ttl: 3600 },
    ]);
  });

  it('fails OPEN when Redis is down — an outage must not block signup', async () => {
    redisState.error = new Error('redis down');
    const log = makeLog();

    const result = await selfSignup(INPUT, log);

    expect(result.ok).toBe(true);
    expect(log.error).toHaveBeenCalled();
  });

  // The tests above pass against the old hardcoded values too, so they don't
  // exercise tunability. These do.
  it('honours an operator-raised per-identifier limit', async () => {
    mockAuthConfig.signup_rate_limit.max_per_identifier = 5;

    for (let i = 0; i < 5; i += 1) {
      expect((await selfSignup(INPUT, makeLog())).ok).toBe(true);
    }
    const result = await selfSignup(INPUT, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_RATE_LIMITED');
  });

  it('stamps the configured window as the Redis TTL', async () => {
    mockAuthConfig.signup_rate_limit.window_seconds = 300;

    await selfSignup(INPUT, makeLog());

    expect(redisState.expires).toEqual([
      { key: `signup:id:${INPUT.email}`, ttl: 300 },
      { key: `signup:ip:${INPUT.clientIp}`, ttl: 3600 },
    ]);
  });
});

describe('failures', () => {
  it('reports a database failure as SIGNUP_FAILED', async () => {
    dbState.selectError = new Error('connection reset');

    const result = await selfSignup(INPUT, makeLog());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('SIGNUP_FAILED');
  });
});
