import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Unit tests for three small boot-time modules that no other test file drives
 * end to end:
 *
 *   - `src/routes/auth/index.ts`  — the better-auth catch-all proxy route
 *     (`/api/auth/*`). Registered as a plugin against a fake fastify so the
 *     captured handler can be invoked directly.
 *   - `src/network_configs.ts`    — the singleton-promise network-config cache
 *     (see apps/api/CLAUDE.md, "Two config-cache patterns") plus its refresh
 *     and by-id lookup paths.
 *   - `src/config.ts`            — the derived-config surface: support-email
 *     normalisation, the production overrides for auth middleware and the API
 *     reference UI, `getCurrentApiBaseUrl()`'s dev port injection and the
 *     Postgres/Redis URL composition fallbacks.
 *
 * `config.ts` and `network_configs.ts` both do their work at module load, so
 * every case mutates `process.env`, calls `vi.resetModules()` and re-imports
 * the module under test. The env keys touched are snapshotted and restored.
 */

// --- mocks (hoisted) -------------------------------------------------------

const { authHandler, loadNetworkConfigsMock, parseDocMock, assertPrimaryMock } =
  vi.hoisted(() => ({
    authHandler: vi.fn(
      async (_req: Request): Promise<Response> => new Response(null, { status: 204 }),
    ),
    loadNetworkConfigsMock: vi.fn(
      async (_options: Record<string, unknown>): Promise<unknown[]> => [],
    ),
    // Identity parse: the tests hand `loadNetworkConfigs` documents already in
    // their final shape so they control `id` / `domains` / `item_schemas`.
    parseDocMock: vi.fn((doc: Record<string, unknown>) => doc),
    assertPrimaryMock: vi.fn(
      (_schema: Record<string, unknown>, _context: string): void => {},
    ),
  }));

vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: { handler: (req: Request) => authHandler(req) },
}));

// Partial mocks: `config.ts` needs the REAL parseServedDomains /
// parseLoginChannels / assertCreateTestOtpSafe, so only the loader is faked.
vi.mock('@dpg/config', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    loadNetworkConfigs: (options: Record<string, unknown>) =>
      loadNetworkConfigsMock(options),
  };
});

vi.mock('@dpg/schemas', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    parseNetworkConfigDocument: (doc: Record<string, unknown>) => parseDocMock(doc),
    assertSinglePrimaryLocation: (
      schema: Record<string, unknown>,
      context: string,
    ) => assertPrimaryMock(schema, context),
  };
});

// --- env snapshot/restore --------------------------------------------------

const MUTATED_ENV_KEYS = [
  'INSTANCE_ENV',
  'API_DOMAIN',
  'API_PORT',
  'API_REFERENCE_ENABLED',
  'API_REFERENCE_FORCE',
  'AUTH_MIDDLEWARE_ENABLED',
  'CREATE_TEST_OTP',
  'SELF_SIGNUP_MODE',
  'SIGNUP_MAX_PER_IDENTIFIER',
  'SIGNUP_RATE_LIMIT_WINDOW_SECONDS',
  'SERVED_DOMAINS',
  'SUPPORT_EMAIL',
  'SUPPORT_CC_EMAIL',
  'POSTGRES_URL',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'DATABASE_PORT',
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PASSWORD',
  'REDIS_PORT',
] as const;

let envSnapshot: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

beforeEach(() => {
  envSnapshot = {};
  for (const key of MUTATED_ENV_KEYS) {
    envSnapshot[key] = process.env[key];
  }
  vi.clearAllMocks();
  // clearAllMocks drops the declared default implementations too.
  authHandler.mockImplementation(async () => new Response(null, { status: 204 }));
  loadNetworkConfigsMock.mockImplementation(async () => []);
  parseDocMock.mockImplementation((doc: Record<string, unknown>) => doc);
  assertPrimaryMock.mockImplementation(() => {});
  vi.resetModules();
});

afterEach(() => {
  for (const key of MUTATED_ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }
});

// --- fakes ----------------------------------------------------------------

type CapturedRoute = {
  method: string[];
  url: string;
  schema: { hide?: boolean };
  config?: { rateLimit?: { max?: number; timeWindow?: string } };
  handler: (request: unknown, reply: unknown) => Promise<unknown>;
};

type ReplyState = {
  statusCode: number | null;
  headers: Record<string, string>;
  body: unknown;
  sendCount: number;
};

type FakeReply = {
  status: (code: number) => FakeReply;
  code: (code: number) => FakeReply;
  header: (key: string, value: string) => FakeReply;
  send: (body?: unknown) => FakeReply;
};

function makeReply(): { reply: FakeReply; state: ReplyState } {
  const state: ReplyState = {
    statusCode: null,
    headers: {},
    body: undefined,
    sendCount: 0,
  };
  const reply: FakeReply = {
    status: (code) => {
      state.statusCode = code;
      return reply;
    },
    code: (code) => {
      state.statusCode = code;
      return reply;
    },
    header: (key, value) => {
      state.headers[key.toLowerCase()] = value;
      return reply;
    },
    send: (body) => {
      state.body = body;
      state.sendCount += 1;
      return reply;
    },
  };
  return { reply, state };
}

async function registerAuthRoutes(): Promise<{
  route: CapturedRoute;
  logError: ReturnType<typeof vi.fn>;
}> {
  const mod = await import('@/routes/auth/index');
  const routes: CapturedRoute[] = [];
  const logError = vi.fn((_err: unknown) => {});
  const fakeFastify = {
    route: (opts: CapturedRoute) => {
      routes.push(opts);
    },
    log: { error: logError },
  };
  const plugin = mod.default as unknown as (
    fastify: unknown,
    opts: unknown,
  ) => Promise<void>;
  await plugin(fakeFastify, {});
  expect(routes).toHaveLength(1);
  return { route: routes[0], logError };
}

// --- routes/auth/index.ts -------------------------------------------------

describe('routes/auth/index.ts (better-auth catch-all proxy)', () => {
  it('registers a hidden GET/POST/OPTIONS catch-all on /api/auth/*', async () => {
    const { route } = await registerAuthRoutes();

    expect(route.url).toBe('/api/auth/*');
    expect(route.method).toEqual(['GET', 'POST', 'OPTIONS']);
    expect(route.schema.hide).toBe(true);
  });

  // Inverted on purpose (#669): this used to assert `route.config.rateLimit`
  // deep-equalled `{ max: 10, timeWindow: '10 seconds' }` under a test name
  // claiming the route was "rate-limited" — but @fastify/rate-limit is not
  // installed or registered, so Fastify ignored the key and the route was
  // unlimited. Asserting the shape of an object nothing read is how the illusion
  // survived. `/api/auth` IS an apiRateLimit group at the ingress (unlike
  // `/api/v1/auth`), so no app-level config is the correct state here.
  it('declares no app-level rateLimit config — the plugin is not installed', async () => {
    const { route } = await registerAuthRoutes();

    expect(route.config?.rateLimit).toBeUndefined();
  });

  it('short-circuits OPTIONS preflight with 204 and never calls better-auth', async () => {
    const { route } = await registerAuthRoutes();
    const { reply, state } = makeReply();

    await route.handler(
      { method: 'OPTIONS', url: '/api/auth/sign-in', headers: {} },
      reply,
    );

    expect(state.statusCode).toBe(204);
    expect(state.sendCount).toBe(1);
    expect(authHandler).not.toHaveBeenCalled();
  });

  it('forwards a GET as an absolute Request built from the host header, skipping undefined headers, and copies response headers/status/text back', async () => {
    authHandler.mockResolvedValueOnce(
      new Response('{"session":null}', {
        status: 201,
        headers: { 'set-cookie': 'session=abc', 'x-echo': 'yes' },
      }),
    );
    const { route } = await registerAuthRoutes();
    const { reply, state } = makeReply();

    await route.handler(
      {
        method: 'GET',
        url: '/api/auth/get-session?a=1',
        headers: { host: 'auth.test', 'x-keep': 'kept', 'x-drop': undefined },
        body: { ignored: true },
      },
      reply,
    );

    const forwarded = authHandler.mock.calls[0][0];
    expect(forwarded.url).toBe('http://auth.test/api/auth/get-session?a=1');
    expect(forwarded.method).toBe('GET');
    expect(forwarded.headers.get('x-keep')).toBe('kept');
    expect(forwarded.headers.get('x-drop')).toBeNull();
    // GET never forwards a body even when fastify parsed one.
    expect(forwarded.body).toBeNull();

    expect(state.statusCode).toBe(201);
    expect(state.headers['set-cookie']).toBe('session=abc');
    expect(state.headers['x-echo']).toBe('yes');
    expect(state.body).toBe('{"session":null}');
  });

  it('JSON-stringifies a POST body, and sends null when the auth response has no body', async () => {
    authHandler.mockResolvedValueOnce(new Response(null, { status: 302 }));
    const { route } = await registerAuthRoutes();
    const { reply, state } = makeReply();

    await route.handler(
      {
        method: 'POST',
        url: '/api/auth/sign-in/email',
        headers: { host: 'auth.test' },
        body: { email: 'a@b.co' },
      },
      reply,
    );

    const forwarded = authHandler.mock.calls[0][0];
    expect(forwarded.method).toBe('POST');
    expect(await forwarded.text()).toBe('{"email":"a@b.co"}');

    expect(state.statusCode).toBe(302);
    expect(state.body).toBeNull();
  });

  it('sends no body for a POST with no parsed body', async () => {
    const { route } = await registerAuthRoutes();

    await route.handler(
      { method: 'POST', url: '/api/auth/sign-out', headers: { host: 'auth.test' } },
      makeReply().reply,
    );

    expect(authHandler.mock.calls[0][0].body).toBeNull();
  });

  it('logs and returns 500 AUTH_FAILURE when better-auth throws', async () => {
    const boom = new Error('better-auth exploded');
    authHandler.mockRejectedValueOnce(boom);
    const { route, logError } = await registerAuthRoutes();
    const { reply, state } = makeReply();

    await route.handler(
      { method: 'GET', url: '/api/auth/get-session', headers: { host: 'auth.test' } },
      reply,
    );

    expect(logError).toHaveBeenCalledWith(boom);
    expect(state.statusCode).toBe(500);
    // NB: this route predates the repo-wide `{ error, message }` envelope — it
    // sends a human string under `error` and the machine code under `code`.
    expect(state.body).toEqual({
      error: 'Internal authentication error',
      code: 'AUTH_FAILURE',
    });
  });
});

// --- network_configs.ts ---------------------------------------------------

type FakeDomain = { id: string; item_schemas: Record<string, unknown> };
type FakeDoc = { id: string; domains: FakeDomain[] };

function doc(id: string, domains: FakeDomain[]): FakeDoc {
  return { id, domains };
}

async function importNetworkConfigs(servedDomains: string) {
  setEnv({ SERVED_DOMAINS: servedDomains });
  vi.resetModules();
  return import('@/network_configs');
}

describe('network_configs.ts (singleton-promise config cache)', () => {
  const docs = () => [
    doc('net_a', [
      { id: 'dom_a', item_schemas: { 'profile_1.0': { kind: 'served' } } },
      { id: 'dom_b', item_schemas: { 'opportunity_1.0': { kind: 'unserved' } } },
    ]),
    doc('net_b', [{ id: 'dom_a', item_schemas: { 'profile_1.0': {} } }]),
  ];

  it('memoises the load: a second getNetworkConfigs() reuses the in-flight promise', async () => {
    loadNetworkConfigsMock.mockImplementation(async () => docs());
    const mod = await importNetworkConfigs('net_a/dom_a');

    const [first, second] = await Promise.all([
      mod.getNetworkConfigs(),
      mod.getNetworkConfigs(),
    ]);

    expect(loadNetworkConfigsMock).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
    expect(first.map((entry) => entry.id)).toEqual(['net_a', 'net_b']);
    expect(await mod.getNetworkConfigs()).toBe(first);
    expect(loadNetworkConfigsMock).toHaveBeenCalledTimes(1);
  });

  it('passes the apiConfig-derived loader options through, including parsed served domains', async () => {
    loadNetworkConfigsMock.mockImplementation(async () => docs());
    const mod = await importNetworkConfigs('net_a/dom_a,net_b/dom_a');
    await mod.getNetworkConfigs();

    const options = loadNetworkConfigsMock.mock.calls[0][0];
    expect(options.servedDomains).toEqual([
      { network: 'net_a', domain: 'dom_a', key: 'net_a/dom_a' },
      { network: 'net_b', domain: 'dom_a', key: 'net_b/dom_a' },
    ]);
    expect(options).toHaveProperty('source');
    expect(options).toHaveProperty('localFile');
  });

  it('validates primary-location markers only for domains this instance serves', async () => {
    loadNetworkConfigsMock.mockImplementation(async () => docs());
    const mod = await importNetworkConfigs('net_a/dom_a');
    await mod.getNetworkConfigs();

    // dom_b (same network, unserved) and net_b/dom_a must be skipped.
    expect(assertPrimaryMock).toHaveBeenCalledTimes(1);
    expect(assertPrimaryMock).toHaveBeenCalledWith(
      { kind: 'served' },
      'net_a/dom_a/profile_1.0',
    );
    expect(parseDocMock).toHaveBeenCalledTimes(2);
  });

  it('refreshNetworkConfigs() reloads and replaces the cached promise', async () => {
    loadNetworkConfigsMock.mockImplementation(async () => docs());
    const mod = await importNetworkConfigs('net_a/dom_a');
    const first = await mod.getNetworkConfigs();

    loadNetworkConfigsMock.mockImplementation(async () => [
      doc('net_c', [{ id: 'dom_a', item_schemas: {} }]),
    ]);
    const refreshed = await mod.refreshNetworkConfigs();

    expect(loadNetworkConfigsMock).toHaveBeenCalledTimes(2);
    expect(refreshed).not.toBe(first);
    expect(refreshed.map((entry) => entry.id)).toEqual(['net_c']);
    // The refreshed value is now what the cached getter returns.
    expect(await mod.getNetworkConfigs()).toBe(refreshed);
    expect(loadNetworkConfigsMock).toHaveBeenCalledTimes(2);
  });

  it('getNetworkConfigById() resolves a configured network and throws for an unknown one', async () => {
    loadNetworkConfigsMock.mockImplementation(async () => docs());
    const mod = await importNetworkConfigs('net_a/dom_a');

    const found = await mod.getNetworkConfigById('net_b');
    expect(found.id).toBe('net_b');

    await expect(mod.getNetworkConfigById('missing_net')).rejects.toThrow(
      'Network "missing_net" is not configured.',
    );
    // The lookup goes through the same memoised load.
    expect(loadNetworkConfigsMock).toHaveBeenCalledTimes(1);
  });

  it('does NOT cache a rejected load: the next call retries and self-heals (no refresh needed)', async () => {
    loadNetworkConfigsMock.mockImplementation(async () => docs());
    assertPrimaryMock.mockImplementation(() => {
      throw new Error('two primary location fields');
    });
    const mod = await importNetworkConfigs('net_a/dom_a');

    await expect(mod.getNetworkConfigs()).rejects.toThrow(
      'two primary location fields',
    );
    // A rejected promise must NOT be memoised — a second call re-invokes the
    // loader rather than replaying the sticky failure (else one transient blip
    // poisons every request for the process lifetime).
    await expect(mod.getNetworkConfigs()).rejects.toThrow(
      'two primary location fields',
    );
    expect(loadNetworkConfigsMock).toHaveBeenCalledTimes(2);

    // Once the underlying issue clears, the very next getNetworkConfigs() recovers
    // on its own — no refreshNetworkConfigs() required.
    assertPrimaryMock.mockImplementation(() => {});
    const recovered = await mod.getNetworkConfigs();
    expect(recovered.map((entry) => entry.id)).toEqual(['net_a', 'net_b']);
    expect(loadNetworkConfigsMock).toHaveBeenCalledTimes(3);
  });
});

// --- config.ts ------------------------------------------------------------

async function importConfig(env: Record<string, string | undefined>) {
  setEnv(env);
  vi.resetModules();
  return import('@/config');
}

describe('config.ts derived configuration', () => {
  it('normalises the support email lists: trims, drops empties, rejoins with ", "', async () => {
    const cfg = await importConfig({
      SUPPORT_EMAIL: ' ops@x.test , , help@x.test,',
      SUPPORT_CC_EMAIL: 'cc@x.test',
    });

    expect(cfg.supportConfig.recipients).toBe('ops@x.test, help@x.test');
    expect(cfg.supportConfig.cc).toBe('cc@x.test');
  });

  it('returns undefined support recipients when unset or when only separators remain', async () => {
    const cfg = await importConfig({
      SUPPORT_EMAIL: undefined,
      SUPPORT_CC_EMAIL: ' , ,, ',
    });

    expect(cfg.supportConfig.recipients).toBeUndefined();
    expect(cfg.supportConfig.cc).toBeUndefined();
  });

  it('honours AUTH_MIDDLEWARE_ENABLED=false only in development', async () => {
    const dev = await importConfig({
      INSTANCE_ENV: 'development',
      AUTH_MIDDLEWARE_ENABLED: 'false',
      CREATE_TEST_OTP: 'false',
    });
    expect(dev.authConfig.middleware_enabled).toBe(false);

    const prod = await importConfig({
      INSTANCE_ENV: 'production',
      AUTH_MIDDLEWARE_ENABLED: 'false',
      CREATE_TEST_OTP: 'false',
    });
    expect(prod.authConfig.middleware_enabled).toBe(true);
  });

  it('derives allow_self_signup from SELF_SIGNUP_MODE and parses LOGIN_CHANNELS', async () => {
    const gated = await importConfig({ SELF_SIGNUP_MODE: 'gated' });
    expect(gated.authConfig.allow_self_signup).toBe(false);
    expect(gated.authConfig.login_channels.length).toBeGreaterThan(0);

    const allowed = await importConfig({ SELF_SIGNUP_MODE: 'allowed' });
    expect(allowed.authConfig.allow_self_signup).toBe(true);
  });

  // The only untested link in the env -> authConfig -> limiter chain. Nothing
  // else covers it: secrets_schemas.test.ts stops at the parsed env object, and
  // self_signup.test.ts mocks @/config with a hand-written signup_rate_limit —
  // so transposing these two fields would give operators a 3-second window and a
  // 3600-attempt ceiling while the whole suite stayed green.
  it('maps the SIGNUP_* env vars onto signup_rate_limit without transposing them', async () => {
    const cfg = await importConfig({
      SIGNUP_MAX_PER_IDENTIFIER: '7',
      SIGNUP_RATE_LIMIT_WINDOW_SECONDS: '900',
    });

    expect(cfg.authConfig.signup_rate_limit).toEqual({
      max_per_identifier: 7,
      window_seconds: 900,
    });
  });

  it('defaults signup_rate_limit to the previously hardcoded values', async () => {
    const cfg = await importConfig({
      SIGNUP_MAX_PER_IDENTIFIER: undefined,
      SIGNUP_RATE_LIMIT_WINDOW_SECONDS: undefined,
    });

    expect(cfg.authConfig.signup_rate_limit).toEqual({
      max_per_identifier: 3,
      window_seconds: 3600,
    });
  });

  it('force-disables the API reference in production unless API_REFERENCE_FORCE is set', async () => {
    const prod = await importConfig({
      INSTANCE_ENV: 'production',
      CREATE_TEST_OTP: 'false',
      API_REFERENCE_ENABLED: 'true',
      API_REFERENCE_FORCE: 'false',
    });
    expect(prod.apiReferenceEnabled).toBe(false);

    const prodForced = await importConfig({
      INSTANCE_ENV: 'production',
      CREATE_TEST_OTP: 'false',
      API_REFERENCE_ENABLED: 'true',
      API_REFERENCE_FORCE: 'true',
    });
    expect(prodForced.apiReferenceEnabled).toBe(true);

    const devOff = await importConfig({
      INSTANCE_ENV: 'development',
      CREATE_TEST_OTP: 'false',
      API_REFERENCE_ENABLED: 'false',
      API_REFERENCE_FORCE: 'true',
    });
    expect(devOff.apiReferenceEnabled).toBe(false);

    const devOn = await importConfig({
      INSTANCE_ENV: 'development',
      CREATE_TEST_OTP: 'false',
      API_REFERENCE_ENABLED: 'true',
      API_REFERENCE_FORCE: 'false',
    });
    expect(devOn.apiReferenceEnabled).toBe(true);
  });

  it('getCurrentApiBaseUrl() injects API_PORT in development when API_DOMAIN has no port and strips the trailing slash', async () => {
    const cfg = await importConfig({
      INSTANCE_ENV: 'development',
      CREATE_TEST_OTP: 'false',
      API_DOMAIN: 'http://localhost',
      API_PORT: '3333',
    });

    expect(cfg.getCurrentApiBaseUrl()).toBe('http://localhost:3333');
  });

  it('getCurrentApiBaseUrl() leaves an explicit port alone and never injects one in production', async () => {
    const dev = await importConfig({
      INSTANCE_ENV: 'development',
      CREATE_TEST_OTP: 'false',
      API_DOMAIN: 'http://localhost:2742/',
      API_PORT: '3333',
    });
    expect(dev.getCurrentApiBaseUrl()).toBe('http://localhost:2742');

    const prod = await importConfig({
      INSTANCE_ENV: 'production',
      CREATE_TEST_OTP: 'false',
      API_DOMAIN: 'https://api.example.test',
      API_PORT: '3333',
    });
    expect(prod.getCurrentApiBaseUrl()).toBe('https://api.example.test');
    expect(prod.apiConfig.domain).toBe('https://api.example.test');
    expect(prod.apiConfig.port).toBe(3333);
  });

  it('composes the Postgres URL from parts, preferring POSTGRES_PORT over DATABASE_PORT', async () => {
    const withPgPort = await importConfig({
      POSTGRES_URL: undefined,
      POSTGRES_USER: 'pguser',
      POSTGRES_PASSWORD: 'pgpassword',
      POSTGRES_DB: 'pgdb',
      POSTGRES_HOST: 'pghost',
      POSTGRES_PORT: '6000',
      DATABASE_PORT: '5555',
    });
    expect(withPgPort.databasesConfig.pg_url).toBe(
      'postgres://pguser:pgpassword@pghost:6000/pgdb',
    );

    const databasePortFallback = await importConfig({
      POSTGRES_URL: undefined,
      POSTGRES_PORT: undefined,
      DATABASE_PORT: '5555',
    });
    expect(databasePortFallback.databasesConfig.pg_url).toBe(
      'postgres://pguser:pgpassword@pghost:5555/pgdb',
    );

    const defaultPort = await importConfig({
      POSTGRES_URL: undefined,
      POSTGRES_PORT: undefined,
      DATABASE_PORT: undefined,
    });
    expect(defaultPort.databasesConfig.pg_url).toBe(
      'postgres://pguser:pgpassword@pghost:5432/pgdb',
    );
  });

  it('prefers explicit POSTGRES_URL / REDIS_URL over the composed forms', async () => {
    const cfg = await importConfig({
      POSTGRES_URL: 'postgres://explicit/db',
      REDIS_URL: 'redis://explicit:6379',
    });

    expect(cfg.databasesConfig.pg_url).toBe('postgres://explicit/db');
    expect(cfg.databasesConfig.redis_url).toBe('redis://explicit:6379');
  });

  it('composes the Redis URL with an empty user and the password inline', async () => {
    const cfg = await importConfig({
      REDIS_URL: undefined,
      REDIS_HOST: 'redishost',
      REDIS_PASSWORD: 'redispassword',
      REDIS_PORT: undefined,
    });

    expect(cfg.databasesConfig.redis_url).toBe(
      'redis://:redispassword@redishost:6370',
    );
    expect(cfg.databasesConfig.redis_port).toBe(6370);
    expect(cfg.databasesConfig.redis_password).toBe('redispassword');
  });

  it('fails boot when CREATE_TEST_OTP is enabled in production', async () => {
    await expect(
      importConfig({ INSTANCE_ENV: 'production', CREATE_TEST_OTP: 'true' }),
    ).rejects.toThrow(/CREATE_TEST_OTP must not be enabled/);
  });
});
