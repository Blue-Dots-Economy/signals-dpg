import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyQs from 'fastify-qs';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * #439 Task 7 — GET /api/v1/action/fetch: the enriched read path (facet
 * filter over counterparty item_state + distance sort/display over item
 * locations), computed at read time over the caller's bounded per-profile
 * action set.
 *
 * Fixture shape: the caller owns MY_ITEM (target side of every action here).
 * Two/three counterparty items sit on the source side, each with a different
 * `looking_for` value and a different (or missing) location, so a single
 * fixture set exercises filter, sort, and display assertions.
 *
 * Registers the real `fastify-qs` plugin (mirrors apps/api/src/app.ts) so
 * `facets[0][field]=...&facets[0][values][0]=...` bracket-notation query
 * strings parse into the nested array-of-objects the Zod query schema
 * expects — the plain Fastify default querystring parser does not do this.
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

const NETWORK = 'net1';
const DOMAIN = 'dom1';
const ITEM_TYPE = 'type1';

// A single reused network config: `looking_for` is a declared, non-private,
// array-valued facet field; `secret_field` is declared but private — the
// no-leak assertion (facet_guard.test.ts's same convention) filters on it
// and expects it to have zero effect, never a 400.
const NETWORK_CONFIG = {
  id: NETWORK,
  domains: [
    {
      id: DOMAIN,
      item_schemas: {
        [ITEM_TYPE]: {
          type: 'object',
          properties: {
            looking_for: { type: 'array', items: { type: 'string' } },
            secret_field: { type: 'string', private: true },
          },
        },
      },
    },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => NETWORK_CONFIG),
}));

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

const { fetch_actions } = await import('../fetch_actions');

const USER_ID = 'user_1';
const OTHER_USER = 'user_other';

const MY_ITEM_ID = '10000000-0000-4000-8000-000000000001';
const MATCH_ITEM_ID = '20000000-0000-4000-8000-000000000002';
const NOMATCH_ITEM_ID = '30000000-0000-4000-8000-000000000003';
const FAR_ITEM_ID = '40000000-0000-4000-8000-000000000004';

const ACTION_1 = '51000000-0000-4000-8000-000000000001'; // counterparty MATCH_ITEM — near, matches facet
const ACTION_2 = '52000000-0000-4000-8000-000000000002'; // counterparty NOMATCH_ITEM — no location, doesn't match facet
const ACTION_3 = '53000000-0000-4000-8000-000000000003'; // counterparty FAR_ITEM — far, no facet check

function makeActionRow(overrides: Record<string, unknown> = {}) {
  return {
    action_type: 'connect',
    partition_network: NETWORK,
    action_id: ACTION_1,
    action_status: 'created',
    update_count: 0,
    source_item_network: NETWORK,
    source_item_domain: DOMAIN,
    source_item_type: ITEM_TYPE,
    source_item_id: MATCH_ITEM_ID,
    source_item_instance_url: 'http://source.local',
    source_item_owner: OTHER_USER,
    target_item_network: NETWORK,
    target_item_domain: DOMAIN,
    target_item_type: ITEM_TYPE,
    target_item_id: MY_ITEM_ID,
    target_item_instance_url: 'http://source.local',
    target_item_owner: USER_ID,
    performed_by_org_id: null,
    performed_by_service_user_id: null,
    requirements_snapshot: {},
    remarks: null,
    match_score: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function makeItemRow(overrides: Record<string, unknown> = {}) {
  return {
    item_id: MY_ITEM_ID,
    item_network: NETWORK,
    item_domain: DOMAIN,
    item_type: ITEM_TYPE,
    item_state: {},
    item_locations: [] as Array<{ lat: number; lng: number }>,
    item_private_state: null,
    lifecycle_status: 'live',
    ...overrides,
  };
}

const MY_ITEM = makeItemRow({
  item_id: MY_ITEM_ID,
  item_locations: [{ lat: 0, lng: 0 }],
});
// ~111m from MY_ITEM.
const MATCH_ITEM = makeItemRow({
  item_id: MATCH_ITEM_ID,
  item_state: { looking_for: ['maths', 'science'], secret_field: 'TOPSECRET' },
  item_locations: [{ lat: 0.001, lng: 0 }],
});
// No location at all — doesn't match the 'maths' facet either.
const NOMATCH_ITEM = makeItemRow({
  item_id: NOMATCH_ITEM_ID,
  item_state: { looking_for: ['science'] },
  item_locations: [],
});
// ~111km from MY_ITEM — farther than MATCH_ITEM, but still a real distance.
const FAR_ITEM = makeItemRow({
  item_id: FAR_ITEM_ID,
  item_state: { looking_for: ['maths'] },
  item_locations: [{ lat: 1, lng: 0 }],
});

async function buildApp(user: { id: string } | null): Promise<FastifyInstance> {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    if (user) (req as unknown as { user: typeof user }).user = user;
  });
  await app.register(fastifyQs, {});
  await app.register(fetch_actions);
  await app.ready();
  return app;
}

// Builds a `facets[0][field]=...&facets[0][values][0]=...` bracket-notation
// query fragment — the shape `fastify-qs` (backed by the `qs` library)
// parses into the nested array-of-objects the Zod query schema expects.
function facetsQueryParam(selections: Array<{ field: string; values: string[] }>) {
  return selections
    .map((selection, i) =>
      [
        `facets[${i}][field]=${encodeURIComponent(selection.field)}`,
        ...selection.values.map(
          (v, j) => `facets[${i}][values][${j}]=${encodeURIComponent(v)}`
        ),
      ].join('&')
    )
    .join('&');
}

beforeEach(() => {
  dbState.selectResults = [];
  dbState.calls = [];
  selectCallCount = 0;
});

describe('GET /api/v1/action/fetch — facet filter + distance sort (#439 Task 7)', () => {
  it('facets=[{field:looking_for,values:[maths]}] returns only rows whose counterparty item_state.looking_for intersects the selection', async () => {
    dbState.selectResults = [
      [makeActionRow({ action_id: ACTION_1 }), makeActionRow({ action_id: ACTION_2, source_item_id: NOMATCH_ITEM_ID })],
      [MY_ITEM, MATCH_ITEM, NOMATCH_ITEM],
    ];
    const app = await buildApp({ id: USER_ID });
    const res = await app.inject({
      method: 'GET',
      url: `/fetch?${facetsQueryParam([{ field: 'looking_for', values: ['maths'] }])}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(1);
    expect(body.actions).toHaveLength(1);
    expect(body.actions[0].action_id).toBe(ACTION_1);
  });

  it('a private/undeclared facet field is dropped — the row set is unaffected and the private item_state value never appears in the response', async () => {
    dbState.selectResults = [
      [makeActionRow({ action_id: ACTION_1 }), makeActionRow({ action_id: ACTION_2, source_item_id: NOMATCH_ITEM_ID })],
      [MY_ITEM, MATCH_ITEM, NOMATCH_ITEM],
    ];
    const app = await buildApp({ id: USER_ID });
    // Deliberately search for a value that does NOT match MATCH_ITEM's real
    // `secret_field` ("TOPSECRET") — if the private field were (incorrectly)
    // enforced, this selection would filter every row out. Because the field
    // is private, resolveAllowedFacetFilters drops it before the row filter
    // ever sees it, so both rows must still come back untouched.
    const res = await app.inject({
      method: 'GET',
      url: `/fetch?${facetsQueryParam([{ field: 'secret_field', values: ['not-the-real-value'] }])}`,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Dropped, not enforced: both rows still present.
    expect(body.meta.total).toBe(2);
    expect(body.actions).toHaveLength(2);
    // The counterparty's actual private item_state value never leaks into
    // the response, regardless of what the client searched for.
    expect(res.payload).not.toContain('TOPSECRET');
  });

  it("sort=distance orders rows by computed item-to-item distance ascending, with no-location rows last", async () => {
    dbState.selectResults = [
      [
        makeActionRow({ action_id: ACTION_2, source_item_id: NOMATCH_ITEM_ID }),
        makeActionRow({ action_id: ACTION_3, source_item_id: FAR_ITEM_ID }),
        makeActionRow({ action_id: ACTION_1, source_item_id: MATCH_ITEM_ID }),
      ],
      [MY_ITEM, MATCH_ITEM, NOMATCH_ITEM, FAR_ITEM],
    ];
    const app = await buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: '/fetch?sort=distance' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actions.map((a: { action_id: string }) => a.action_id)).toEqual([
      ACTION_1, // ~111m — nearest
      ACTION_3, // ~111km — farther, but a real distance
      ACTION_2, // no location — last
    ]);
    expect(body.actions[0].distance_m).toBeGreaterThan(0);
    expect(body.actions[0].distance_m).toBeLessThan(body.actions[1].distance_m);
    expect(body.actions[2].distance_m).toBeNull();
  });

  it('fast path (no facets, sort=recent default) still carries a computed distance_m per row for display', async () => {
    dbState.selectResults = [
      [{ count: 2 }],
      [
        makeActionRow({ action_id: ACTION_1, source_item_id: MATCH_ITEM_ID }),
        makeActionRow({ action_id: ACTION_2, source_item_id: NOMATCH_ITEM_ID }),
      ],
      [MY_ITEM, MATCH_ITEM, NOMATCH_ITEM],
    ];
    const app = await buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: '/fetch' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.meta.total).toBe(2);
    const byId = new Map(body.actions.map((a: { action_id: string; distance_m: number | null }) => [a.action_id, a.distance_m]));
    expect(byId.get(ACTION_1)).toBeGreaterThan(0);
    expect(byId.get(ACTION_1)).toBeLessThan(1000); // ~111m
    expect(byId.get(ACTION_2)).toBeNull();
  });
});
