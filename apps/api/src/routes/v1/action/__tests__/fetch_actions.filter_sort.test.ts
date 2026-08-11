import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * #439 Task 6 — GET /api/v1/action/fetch: multi-value action_status/action_type
 * filters (inArray), the `sort` fast path (recent/oldest/match_score), the
 * item_id ownership guard (403 FORBIDDEN_ITEM), and meta.applied.
 *
 * All test cases here return an empty `item_actions` rows page, so
 * resolveItemNames's items-table lookup (only reached when rows.length > 0)
 * never fires — keeping the db mock to exactly the calls fetch_actions.ts
 * itself makes: an optional ownership-check select, then count, then rows.
 */

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
  },
  authConfig: {
    secret: 'test-secret',
    middleware_enabled: false,
    url: 'http://source.local/api/auth',
    create_test_otp: false,
  },
  matchScoreConfig: { provider: 'noop', signals_search: {} },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {},
  databases: {},
  matchScore: {},
  notification: {},
  networkRuntime: {},
  schemaRegistry: {},
}));

vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: {
    api: { getSession: vi.fn(async () => null) },
    handler: vi.fn(),
  },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => null),
}));

// --- spy on drizzle-orm's inArray/sql (keep everything else real) so we can
// assert the multi-value filter and the match_score SQL fragment without
// trying to introspect compiled SQL objects directly. ---
vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    inArray: vi.fn(actual.inArray),
    sql: vi.fn(actual.sql) as unknown as typeof actual.sql,
  };
});

// --- generic chainable db.select() mock. Each call to db.select() pops the
// next queued result off dbState.selectResults (call order is deterministic
// given the handler code: [ownership check?], count, rows) and records
// .where()/.orderBy()/.limit()/.offset() args into dbState.calls so tests can
// inspect what was applied to each individual query. ---
type CallRecord = {
  where: unknown[];
  orderBy: unknown[][];
  limit?: number;
  offset?: number;
};

const dbState: {
  selectResults: unknown[][];
  calls: CallRecord[];
} = { selectResults: [], calls: [] };

let selectCallCount = 0;

function makeChain(result: unknown[]) {
  const record: CallRecord = { where: [], orderBy: [] };
  dbState.calls.push(record);
  const node: Record<string, unknown> = {
    from: vi.fn(() => node),
    where: vi.fn((cond: unknown) => {
      record.where.push(cond);
      return node;
    }),
    orderBy: vi.fn((...args: unknown[]) => {
      record.orderBy.push(args);
      return node;
    }),
    limit: vi.fn((n: number) => {
      record.limit = n;
      return node;
    }),
    offset: vi.fn((n: number) => {
      record.offset = n;
      return node;
    }),
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
    catch: (reject: (e: unknown) => void) => Promise.resolve(result).catch(reject),
  };
  return node;
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: vi.fn(() => {
      const result = dbState.selectResults[selectCallCount] ?? [];
      selectCallCount++;
      return makeChain(result);
    }),
  },
}));

// Imported after mocks — `item_actions`/`items` are real drizzle table refs
// (no db connection at import time), and `inArray`/`sql` are the spies above.
const { fetch_actions } = await import('../fetch_actions');
const { item_actions } = await import('@dpg/database');
const { inArray, sql } = await import('drizzle-orm');

const USER_ID = 'user_1';
const ITEM_ID = '11111111-1111-4111-8111-111111111111';

function buildApp(user: { id: string } | null): FastifyInstance {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
  });
  app.register(fetch_actions);
  return app;
}

beforeEach(() => {
  dbState.selectResults = [];
  dbState.calls = [];
  selectCallCount = 0;
  vi.mocked(inArray).mockClear();
  vi.mocked(sql).mockClear();
});

describe('GET /api/v1/action/fetch — filter/sort/ownership (#439)', () => {
  it('action_status=[created,pending] produces an inArray condition on item_actions.action_status', async () => {
    dbState.selectResults = [[{ count: 0 }], []]; // count, rows
    const app = buildApp({ id: USER_ID });
    const res = await app.inject({
      method: 'GET',
      url: '/fetch?action_status=created&action_status=pending',
    });
    expect(res.statusCode).toBe(200);
    expect(inArray).toHaveBeenCalledWith(item_actions.action_status, [
      'created',
      'pending',
    ]);
  });

  it("sort=match_score orders by match_score DESC NULLS LAST, then updated_at", async () => {
    dbState.selectResults = [[{ count: 0 }], []]; // count, rows
    const app = buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: '/fetch?sort=match_score' });
    expect(res.statusCode).toBe(200);

    // The rows-query chain is the one whose .orderBy() was actually invoked
    // (count never calls orderBy).
    const rowsCall = dbState.calls.find((c) => c.orderBy.length > 0);
    expect(rowsCall).toBeDefined();
    expect(rowsCall!.orderBy[0]).toHaveLength(2);

    // First orderBy arg is the sql`${match_score} DESC NULLS LAST` template —
    // assert via the sql spy rather than trying to compile the SQL object.
    const matchScoreSqlCall = vi
      .mocked(sql)
      .mock.calls.find((args) =>
        (args[0] as unknown as string[]).join('').includes('DESC NULLS LAST'),
      );
    expect(matchScoreSqlCall).toBeDefined();
  });

  it('non-owned item_id → 403 FORBIDDEN_ITEM', async () => {
    dbState.selectResults = [[{ created_by: 'someone_else' }]]; // ownership check only
    const app = buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: `/fetch?item_id=${ITEM_ID}` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'FORBIDDEN_ITEM' });
  });

  it('non-existent item_id → 403 FORBIDDEN_ITEM (no existence leak vs non-owned)', async () => {
    dbState.selectResults = [[]]; // ownership check finds no row
    const app = buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: `/fetch?item_id=${ITEM_ID}` });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'FORBIDDEN_ITEM' });
  });

  it('owned item_id passes the guard and proceeds to 200', async () => {
    dbState.selectResults = [
      [{ created_by: USER_ID }], // ownership check
      [{ count: 0 }], // count
      [], // rows
    ];
    const app = buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: `/fetch?item_id=${ITEM_ID}` });
    expect(res.statusCode).toBe(200);
  });

  it('meta.applied echoes { sort, statuses, types, facets }', async () => {
    dbState.selectResults = [[{ count: 0 }], []]; // count, rows
    const app = buildApp({ id: USER_ID });
    const res = await app.inject({
      method: 'GET',
      url:
        '/fetch?sort=match_score&action_status=created&action_status=pending&action_type=apply',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.applied).toEqual({
      sort: 'match_score',
      statuses: ['created', 'pending'],
      types: ['apply'],
      facets: [],
    });
  });
});
