import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Cross-directory unit tests for two small, otherwise integration-only
 * modules:
 *   - routes/v1/auth/u18_precheck.ts            (public pre-auth minor hint)
 *   - services/geocoding/resolve_locations_for_create.ts
 *
 * They live in `src/__tests__/` because the file spans three directories; every
 * dependency (db, redis, network config, geocoder) is mocked.
 *
 * Guardian OTP email coverage moved with the #529 dispatchEmail migration:
 * the pure mapper is `services/__tests__/guardian_otp_dispatch.test.ts` and the
 * send path is `services/__tests__/guardian_otp_send.test.ts`.
 */

// --- mocks (hoisted) -------------------------------------------------------
const {
  userRows,
  ownedRows,
  dbState,
  redisIncr,
  redisExpire,
  eq,
  and,
  getNetworkConfigById,
  guardianConsentRequired,
  resolveCoordinates,
  parseLocationFields,
  buildLocationQueries,
  getDomainItemSchema,
} = vi.hoisted(() => ({
  // Two independent FIFOs: the user lookup (`select`) and the owned-domain
  // scan (`selectDistinct`) are distinct query shapes in u18_precheck.
  userRows: [] as unknown[][],
  ownedRows: [] as unknown[][],
  // Resettable failure flag + call counters. Never monkey-patch the shared row
  // queues — an override there leaks into every later test in the file.
  dbState: {
    failWith: null as Error | null,
    selectCalls: 0,
    whereArgs: [] as unknown[],
  },
  redisIncr: vi.fn(async (_key: string): Promise<number> => 1),
  redisExpire: vi.fn(async (_key: string, _sec: number): Promise<number> => 1),
  eq: vi.fn((col: unknown, val: unknown) => ({ op: 'eq', col, val })),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: vi.fn((...parts: any[]) => ({ op: 'and', parts })),
  getNetworkConfigById: vi.fn(async (_id: string): Promise<unknown> => null),
  guardianConsentRequired: vi.fn((_cfg: unknown, _domain: string) => false),
  resolveCoordinates: vi.fn(async (_query: string): Promise<unknown> => null),
  parseLocationFields: vi.fn((_schema: unknown): unknown => ({
    primary: null,
    secondary: [],
  })),
  buildLocationQueries: vi.fn(
    (_state: unknown, _primary: unknown): Array<{ query: string; label?: string }> => [],
  ),
  getDomainItemSchema: vi.fn(
    (_cfg: unknown, _domain: string, _type: string): unknown => null,
  ),
}));

function nextRows(queue: unknown[][]) {
  if (dbState.failWith) return Promise.reject(dbState.failWith);
  return Promise.resolve(queue.shift() ?? []);
}

function thenable(queue: unknown[][]) {
  // BOTH callbacks must be forwarded — dropping `rej` makes a rejected query
  // hang the await until the test timeout.
  return {
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      nextRows(queue).then(res, rej),
    limit: () => nextRows(queue),
  };
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => {
      dbState.selectCalls += 1;
      return {
        from: () => ({
          where: (w: unknown) => {
            dbState.whereArgs.push(w);
            return thenable(userRows);
          },
        }),
      };
    },
    selectDistinct: () => ({
      from: () => ({
        where: (w: unknown) => {
          dbState.whereArgs.push(w);
          return thenable(ownedRows);
        },
      }),
    }),
  },
}));

vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    incr: (key: string) => redisIncr(key),
    expire: (key: string, sec: number) => redisExpire(key, sec),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  user: {
    id: 'user.id',
    age: 'user.age',
    email: 'user.email',
    phoneNumber: 'user.phoneNumber',
  },
}));

vi.mock('@dpg/database', () => ({
  items: {
    item_domain: 'items.item_domain',
    item_network: 'items.item_network',
    created_by: 'items.created_by',
  },
}));

vi.mock('drizzle-orm', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: (...a: any[]) => eq(a[0], a[1]),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: (...a: any[]) => and(...a),
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@dpg/schemas', () => {
  const leaf: Record<string, () => unknown> = {
    min: () => leaf,
    email: () => leaf,
    optional: () => leaf,
  };
  return {
    default: {
      object: (shape: unknown) => ({ shape }),
      string: () => leaf,
      boolean: () => leaf,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getDomainItemSchema: (...a: any[]) => getDomainItemSchema(a[0], a[1], a[2]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    parseLocationFields: (...a: any[]) => parseLocationFields(a[0]),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    buildLocationQueries: (...a: any[]) => buildLocationQueries(a[0], a[1]),
  };
});

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (id: string) => getNetworkConfigById(id),
}));

vi.mock('@/services/minor', () => ({
  guardianConsentRequired: (cfg: unknown, domain: string) =>
    guardianConsentRequired(cfg, domain),
}));

vi.mock('@/services/geocoding/geo_resolver', () => ({
  resolveCoordinates: (q: string) => resolveCoordinates(q),
}));

import { u18_precheck } from '@/routes/v1/auth/u18_precheck';
import {
  resolveLocationsForCreate,
  geocodeLocationsFromState,
} from '@/services/geocoding/resolve_locations_for_create';

// --- fake fastify / reply ---------------------------------------------------
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
  schema?: Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: any;
}

async function loadPrecheckRoute(): Promise<FakeRoute> {
  const routes: FakeRoute[] = [];
  const fakeFastify = {
    route: (opts: FakeRoute) => {
      routes.push(opts);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await u18_precheck(fakeFastify as any, {} as any);
  const route = routes[0];
  if (!route) throw new Error('u18_precheck registered no route');
  return route;
}

const log = { error: vi.fn(), warn: vi.fn() };

function callPrecheck(route: FakeRoute, req: Record<string, unknown>) {
  const reply = makeReply();
  return route.handler({ log, ip: '1.2.3.4', ...req }, reply).then(() => reply);
}

beforeEach(() => {
  userRows.length = 0;
  ownedRows.length = 0;
  dbState.failWith = null;
  dbState.selectCalls = 0;
  dbState.whereArgs.length = 0;
  vi.clearAllMocks();
  redisIncr.mockImplementation(async () => 1);
  redisExpire.mockImplementation(async () => 1);
  guardianConsentRequired.mockImplementation(() => false);
  getNetworkConfigById.mockImplementation(async () => null);
  resolveCoordinates.mockImplementation(async () => null);
  parseLocationFields.mockImplementation(() => ({ primary: null, secondary: [] }));
  buildLocationQueries.mockImplementation(() => []);
  getDomainItemSchema.mockImplementation(() => null);
});

// ===========================================================================
// u18_precheck
// ===========================================================================
describe('u18_precheck', () => {
  it('registers POST /u18-precheck', async () => {
    const route = await loadPrecheckRoute();
    expect(route.url).toBe('/u18-precheck');
    expect(route.method).toBe('POST');
  });

  it('sets the rate-limit window TTL only on the first hit of the window', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([]);

    await callPrecheck(route, { body: { network: 'blue_dot', email: 'a@b.com' } });

    expect(redisIncr).toHaveBeenCalledWith('u18_precheck_rl:1.2.3.4');
    expect(redisExpire).toHaveBeenCalledWith('u18_precheck_rl:1.2.3.4', 60);
  });

  it('does not re-set the TTL on subsequent hits', async () => {
    const route = await loadPrecheckRoute();
    redisIncr.mockImplementation(async () => 2);
    userRows.push([]);

    await callPrecheck(route, { body: { network: 'blue_dot', email: 'a@b.com' } });

    expect(redisExpire).not.toHaveBeenCalled();
  });

  it('answers benignly (false) and skips the DB once over the window limit', async () => {
    const route = await loadPrecheckRoute();
    redisIncr.mockImplementation(async () => 21);

    const reply = await callPrecheck(route, {
      body: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ requiresDob: false });
    expect(dbState.selectCalls).toBe(0);
  });

  it('still serves at exactly the limit (n === 20)', async () => {
    const route = await loadPrecheckRoute();
    redisIncr.mockImplementation(async () => 20);
    userRows.push([{ id: 'u1', age: null }]);
    ownedRows.push([{ domain: 'student' }]);
    getNetworkConfigById.mockImplementation(async () => ({ domains: [] }));
    guardianConsentRequired.mockImplementation(() => true);

    const reply = await callPrecheck(route, {
      body: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.body).toEqual({ requiresDob: true });
    expect(dbState.selectCalls).toBe(1);
  });

  it('is fail-safe: a limiter error still answers from the DB', async () => {
    const route = await loadPrecheckRoute();
    redisIncr.mockImplementation(async () => {
      throw new Error('redis down');
    });
    userRows.push([{ id: 'u1', age: null }]);
    ownedRows.push([{ domain: 'student' }]);
    getNetworkConfigById.mockImplementation(async () => ({ domains: [] }));
    guardianConsentRequired.mockImplementation(() => true);

    const reply = await callPrecheck(route, {
      body: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ requiresDob: true });
  });

  it('returns false without querying when neither email nor phone is given', async () => {
    const route = await loadPrecheckRoute();

    const reply = await callPrecheck(route, { body: { network: 'blue_dot' } });

    expect(reply.body).toEqual({ requiresDob: false });
    expect(dbState.selectCalls).toBe(0);
  });

  it('matches on the trimmed, lower-cased email', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([]);

    await callPrecheck(route, {
      body: { network: 'blue_dot', email: '  Mixed.Case@Example.COM  ' },
    });

    expect(eq).toHaveBeenCalledWith('user.email', 'mixed.case@example.com');
  });

  it('falls back to the trimmed phone number when no email is supplied', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([]);

    await callPrecheck(route, {
      body: { network: 'blue_dot', phoneNumber: ' +919999999999 ' },
    });

    expect(eq).toHaveBeenCalledWith('user.phoneNumber', '+919999999999');
    expect(eq).not.toHaveBeenCalledWith('user.email', expect.anything());
  });

  it('returns false for an unknown identifier (no enumeration signal)', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([]);

    const reply = await callPrecheck(route, {
      body: { network: 'blue_dot', email: 'nobody@example.com' },
    });

    expect(reply.body).toEqual({ requiresDob: false });
    // Bailed before the partition-wide owned-domain scan.
    expect(getNetworkConfigById).not.toHaveBeenCalled();
  });

  it('returns false when the user already has an age on file', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([{ id: 'u1', age: 15 }]);

    const reply = await callPrecheck(route, {
      body: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.body).toEqual({ requiresDob: false });
    expect(getNetworkConfigById).not.toHaveBeenCalled();
  });

  it('returns false when no owned domain is guardian-gated', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([{ id: 'u1', age: null }]);
    ownedRows.push([{ domain: 'mentor' }, { domain: 'employer' }]);
    getNetworkConfigById.mockImplementation(async () => ({ domains: [] }));
    guardianConsentRequired.mockImplementation(() => false);

    const reply = await callPrecheck(route, {
      body: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.body).toEqual({ requiresDob: false });
    expect(guardianConsentRequired).toHaveBeenCalledTimes(2);
  });

  it('returns true when any owned domain is guardian-gated', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([{ id: 'u1', age: null }]);
    ownedRows.push([{ domain: 'mentor' }, { domain: 'student' }]);
    const cfg = { domains: [{ id: 'student', guardian_consent_required: true }] };
    getNetworkConfigById.mockImplementation(async () => cfg);
    guardianConsentRequired.mockImplementation((_c: unknown, d: string) => d === 'student');

    const reply = await callPrecheck(route, {
      body: { network: 'blue_dot', email: 'a@b.com' },
    });

    expect(reply.body).toEqual({ requiresDob: true });
    expect(guardianConsentRequired).toHaveBeenCalledWith(cfg, 'student');
    // Owned-domain scan is scoped to network + creator.
    expect(and).toHaveBeenCalled();
    expect(eq).toHaveBeenCalledWith('items.item_network', 'blue_dot');
    expect(eq).toHaveBeenCalledWith('items.created_by', 'u1');
  });

  it('returns false when the network config cannot be loaded', async () => {
    const route = await loadPrecheckRoute();
    userRows.push([{ id: 'u1', age: null }]);
    ownedRows.push([{ domain: 'student' }]);
    getNetworkConfigById.mockImplementation(async () => {
      throw new Error('no such network');
    });

    const reply = await callPrecheck(route, {
      body: { network: 'ghost_dot', email: 'a@b.com' },
    });

    expect(reply.body).toEqual({ requiresDob: false });
    expect(guardianConsentRequired).not.toHaveBeenCalled();
  });

  it('propagates a DB failure instead of returning an error envelope', async () => {
    // Documented discrepancy: the route has no try/catch around its queries, so
    // a DB outage rejects out of the handler (Fastify -> 500) rather than the
    // repo-standard `reply.code(N).send({ error, message })`.
    const route = await loadPrecheckRoute();
    dbState.failWith = new Error('db down');

    await expect(
      callPrecheck(route, { body: { network: 'blue_dot', email: 'a@b.com' } }),
    ).rejects.toThrow('db down');
  });
});

// ===========================================================================
// resolve_locations_for_create
// ===========================================================================
describe('resolveLocationsForCreate', () => {
  const args = {
    item_network: 'blue_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    item_state: { address: 'Bengaluru' },
  };

  it('uses caller-provided coordinates as-is and never geocodes over them', async () => {
    const provided = [{ lat: 1, lng: 2, label: 'home' }];

    const out = await resolveLocationsForCreate({ ...args, provided });

    expect(out).toBe(provided);
    expect(getNetworkConfigById).not.toHaveBeenCalled();
    expect(resolveCoordinates).not.toHaveBeenCalled();
  });

  it('geocodes when provided is an empty array', async () => {
    getNetworkConfigById.mockImplementation(async () => ({ id: 'blue_dot' }));
    getDomainItemSchema.mockImplementation(() => ({ properties: {} }));
    buildLocationQueries.mockImplementation(() => [{ query: 'Bengaluru' }]);
    resolveCoordinates.mockImplementation(async () => ({ lat: 12.9, lng: 77.6 }));

    const out = await resolveLocationsForCreate({ ...args, provided: [] });

    expect(out).toEqual([{ lat: 12.9, lng: 77.6 }]);
    expect(getDomainItemSchema).toHaveBeenCalledWith(
      { id: 'blue_dot' },
      'student',
      'profile_1.0',
    );
  });

  it('returns [] when the domain has no item schema', async () => {
    getNetworkConfigById.mockImplementation(async () => ({ id: 'blue_dot' }));
    getDomainItemSchema.mockImplementation(() => null);

    const out = await resolveLocationsForCreate(args);

    expect(out).toEqual([]);
    expect(parseLocationFields).not.toHaveBeenCalled();
  });

  it('is best-effort: a network-config failure returns [] and warns', async () => {
    const warn = vi.fn((_obj: unknown, _msg: string) => {});
    getNetworkConfigById.mockImplementation(async () => {
      throw new Error('config unreachable');
    });

    const out = await resolveLocationsForCreate({ ...args, log: { warn } });

    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe(
      'backend geocoding failed; creating item without coordinates',
    );
    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      item_network: 'blue_dot',
      item_domain: 'student',
    });
  });

  it('survives a config failure with no logger attached', async () => {
    getNetworkConfigById.mockImplementation(async () => {
      throw new Error('config unreachable');
    });

    await expect(resolveLocationsForCreate(args)).resolves.toEqual([]);
  });
});

describe('geocodeLocationsFromState', () => {
  const schema = { properties: { address: { location: 'primary' } } };

  it('attaches a label only when the query carries one and drops unresolved queries', async () => {
    parseLocationFields.mockImplementation(() => ({
      primary: { field: 'address', cardinality: 'multiple' },
      secondary: [],
    }));
    buildLocationQueries.mockImplementation(() => [
      { query: 'Bengaluru', label: 'Bengaluru' },
      { query: 'Nowhere' },
      { query: 'Pune' },
    ]);
    resolveCoordinates.mockImplementation(async (q: string) =>
      q === 'Nowhere' ? null : { lat: q.length, lng: 1 },
    );

    const out = await geocodeLocationsFromState(schema, { address: ['Bengaluru', 'Pune'] });

    expect(out).toEqual([
      { lat: 9, lng: 1, label: 'Bengaluru' },
      { lat: 4, lng: 1 },
    ]);
    expect(resolveCoordinates).toHaveBeenCalledTimes(3);
  });

  it('returns [] when the schema declares no primary location field', async () => {
    buildLocationQueries.mockImplementation(() => []);

    const out = await geocodeLocationsFromState({ properties: {} }, {});

    expect(out).toEqual([]);
    expect(resolveCoordinates).not.toHaveBeenCalled();
  });

  it('warns and returns [] when the geocoder throws', async () => {
    const warn = vi.fn((_obj: unknown, _msg: string) => {});
    buildLocationQueries.mockImplementation(() => [{ query: 'Bengaluru' }]);
    resolveCoordinates.mockImplementation(async () => {
      throw new Error('geocoder down');
    });

    const out = await geocodeLocationsFromState(schema, { address: 'Bengaluru' }, { warn });

    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, 'geocoding failed');
  });

  it('warns and returns [] when field parsing throws', async () => {
    const warn = vi.fn((_obj: unknown, _msg: string) => {});
    parseLocationFields.mockImplementation(() => {
      throw new Error('bad schema');
    });

    const out = await geocodeLocationsFromState(schema, {}, { warn });

    expect(out).toEqual([]);
    expect(warn).toHaveBeenCalledWith({ err: expect.any(Error) }, 'geocoding failed');
  });
});
