import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
// `user_domains` only exports the plugin, so the handlers are reached by
// registering the plugin against a fake fastify and pulling the routes back
// out. Both handlers run one SELECT; the POST handler then runs an UPDATE.
const { rowQueue, updates, dbState, auth_middleware_if_enabled } = vi.hoisted(() => ({
  rowQueue: [] as unknown[][],
  updates: [] as { table: unknown; values: unknown; where: unknown }[],
  // Resettable failure flag — never monkey-patch the shared row queue, an
  // override there leaks into every later test in the file.
  dbState: { failWith: null as Error | null },
  // Params declared so the spread-through in the vi.mock factory below
  // typechecks; vi.fn(async () => {}) infers a zero-arg signature.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth_middleware_if_enabled: vi.fn(async (..._a: any[]) => {}),
}));

function nextRows() {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(rowQueue.shift() ?? []);
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => {
          // A thenable so both `await .where(...)` and `.limit()` work. BOTH
          // callbacks must be forwarded — dropping `rej` makes a rejected
          // query hang the await forever.
          const result = {
            then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
              nextRows().then(res, rej),
            limit: () => nextRows(),
          };
          return result;
        },
      }),
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (where: unknown) => {
          if (dbState.failWith) return Promise.reject(dbState.failWith);
          updates.push({ table, values, where });
          return Promise.resolve([]);
        },
      }),
    }),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  user: { id: 'user.id', domains: 'user.domains', updatedAt: 'user.updatedAt' },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  auth_middleware_if_enabled: (...a: any[]) => auth_middleware_if_enabled(...a),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ op: 'eq', col, val }),
}));

vi.mock('@dpg/schemas', () => {
  const leaf = { min: () => leaf };
  return {
    default: {
      object: (shape: unknown) => ({ shape }),
      array: () => leaf,
      string: () => leaf,
    },
  };
});

vi.mock('@/config', () => ({
  apiConfig: {
    served_domains: [{ domain: 'student' }, { domain: 'mentor' }],
  },
}));

import { user_domains } from '../user_domains';

interface FakeReply {
  statusCode: number;
  body: unknown;
  code(c: number): FakeReply;
  send(b: unknown): FakeReply;
}

function makeReply(): FakeReply {
  return {
    statusCode: 0,
    body: undefined,
    code(c) {
      this.statusCode = c;
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
  };
}

interface FakeRoute {
  url: string;
  method: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  preHandler?: (...a: any[]) => unknown;
  schema?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any;
}

const routes: FakeRoute[] = [];

async function loadRoutes() {
  routes.length = 0;
  const fakeFastify = {
    route: (opts: FakeRoute) => {
      routes.push(opts);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await user_domains(fakeFastify as any, {} as any);
}

function routeFor(method: string): FakeRoute {
  const found = routes.find((r) => r.method === method);
  if (!found) throw new Error(`no ${method} /domains route registered`);
  return found;
}

const log = { error: vi.fn() };

function call(method: string, req: Record<string, unknown>) {
  const reply = makeReply();
  return routeFor(method)
    .handler({ log, ...req }, reply)
    .then(() => reply);
}

beforeEach(async () => {
  rowQueue.length = 0;
  updates.length = 0;
  dbState.failWith = null;
  vi.clearAllMocks();
  await loadRoutes();
});

describe('user_domains plugin registration', () => {
  it('registers GET and POST /domains, both behind auth', async () => {
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => `${r.method} ${r.url}`).sort()).toEqual([
      'GET /domains',
      'POST /domains',
    ]);
    for (const route of routes) {
      // The preHandler must be wired per-route: this group file has no
      // group-level auth hook, so a missing preHandler means unauthenticated.
      expect(typeof route.preHandler).toBe('function');
      expect(route.schema?.tags).toEqual(['user']);
    }
  });

  it('the registered preHandler is the shared auth middleware', async () => {
    await routeFor('GET').preHandler?.({}, {});
    expect(auth_middleware_if_enabled).toHaveBeenCalledTimes(1);
  });

  it('only the POST route declares a request body schema', async () => {
    expect(routeFor('GET').schema?.body).toBeUndefined();
    expect(routeFor('POST').schema?.body).toBeDefined();
  });
});

describe('GET /domains', () => {
  it('401 UNAUTHORIZED when there is no authenticated user', async () => {
    const reply = await call('GET', { user: undefined });

    expect(reply.statusCode).toBe(401);
    expect(reply.body).toEqual({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  });

  it('returns the stored domains for the current user', async () => {
    rowQueue.push([{ domains: ['student', 'mentor'] }]);

    const reply = await call('GET', { user: { id: 'u1' } });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: ['student', 'mentor'] });
  });

  it('returns an empty array when the column is null', async () => {
    rowQueue.push([{ domains: null }]);

    const reply = await call('GET', { user: { id: 'u1' } });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: [] });
  });

  it('returns an empty array when no user row is found', async () => {
    rowQueue.push([]);

    const reply = await call('GET', { user: { id: 'ghost' } });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: [] });
  });

  it('propagates a failing read (the route has no try/catch)', async () => {
    dbState.failWith = new Error('db down');

    await expect(call('GET', { user: { id: 'u1' } })).rejects.toThrow('db down');
  });
});

describe('POST /domains', () => {
  it('401 UNAUTHORIZED when there is no authenticated user', async () => {
    const reply = await call('POST', { user: undefined, body: { domains: ['student'] } });

    expect(reply.statusCode).toBe(401);
    expect((reply.body as { error: string }).error).toBe('UNAUTHORIZED');
    expect(updates).toHaveLength(0);
  });

  it('400 UNSERVED_DOMAIN for a domain this instance does not serve', async () => {
    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['martian'] },
    });

    expect(reply.statusCode).toBe(400);
    expect(reply.body).toEqual({
      error: 'UNSERVED_DOMAIN',
      message: 'Not served: martian',
    });
    // Nothing may be written — an arbitrary string would poison the picker.
    expect(updates).toHaveLength(0);
  });

  it('lists every unserved domain and rejects the whole request', async () => {
    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student', 'martian', 'venusian'] },
    });

    expect(reply.statusCode).toBe(400);
    expect((reply.body as { message: string }).message).toBe('Not served: martian, venusian');
    expect(updates).toHaveLength(0);
  });

  it('unions with existing domains so a second role adds rather than clobbers', async () => {
    rowQueue.push([{ domains: ['student'] }]);

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['mentor'] },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: ['student', 'mentor'] });
    expect(updates).toHaveLength(1);
    expect((updates[0].values as { domains: string[] }).domains).toEqual(['student', 'mentor']);
  });

  it('is idempotent: re-posting an already stored domain does not duplicate it', async () => {
    rowQueue.push([{ domains: ['student'] }]);

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student'] },
    });

    expect(reply.body).toEqual({ domains: ['student'] });
    expect((updates[0].values as { domains: string[] }).domains).toEqual(['student']);
  });

  it('de-duplicates repeats inside the request body', async () => {
    rowQueue.push([{ domains: null }]);

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['mentor', 'mentor', 'student'] },
    });

    expect(reply.body).toEqual({ domains: ['mentor', 'student'] });
  });

  it('stores the posted domains when the user has none yet', async () => {
    rowQueue.push([]);

    const reply = await call('POST', {
      user: { id: 'u1' },
      body: { domains: ['student'] },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ domains: ['student'] });
  });

  it('stamps updatedAt and scopes the write to the current user', async () => {
    rowQueue.push([{ domains: [] }]);

    await call('POST', { user: { id: 'u1' }, body: { domains: ['student'] } });

    const values = updates[0].values as { domains: string[]; updatedAt: Date };
    expect(values.updatedAt).toBeInstanceOf(Date);
    expect(updates[0].where).toEqual({ op: 'eq', col: 'user.id', val: 'u1' });
    expect(updates[0].table).toEqual({
      id: 'user.id',
      domains: 'user.domains',
      updatedAt: 'user.updatedAt',
    });
  });

  it('validates against served domains before touching the database', async () => {
    // The unserved check runs before the SELECT, so the queued row is untouched.
    rowQueue.push([{ domains: ['student'] }]);

    await call('POST', { user: { id: 'u1' }, body: { domains: ['martian'] } });

    expect(rowQueue).toHaveLength(1);
  });

  it('propagates a failing write (the route has no try/catch)', async () => {
    dbState.failWith = new Error('db down');

    await expect(
      call('POST', { user: { id: 'u1' }, body: { domains: ['student'] } }),
    ).rejects.toThrow('db down');
  });
});
