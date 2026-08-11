import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyQs from 'fastify-qs';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * #439 — GET /api/v1/action/fetch: the PII name reveal-gate as wired into the
 * fetch path (the security-critical line). A counterparty with a PRIVATE name
 * (e.g. a seeker's `beneficiary_name`) must stay MASKED until this action's
 * status is in the network's schema-declared `reveals_pii_on_status`, and even
 * then only while the named profile is `live` (#273).
 *
 * `getInteractionPiiRevealStatuses` is unit-tested on its own elsewhere; this
 * exercises its USE in fetch_actions — the reveal decision + the lazy decrypt —
 * with a fixture that actually carries a private-name row (the existing
 * enrich/filter_sort fixtures do not).
 *
 * Mocking mirrors fetch_actions.enrich.test.ts: config/auth stubbed, the `db`
 * chain returns queued results in call order, and `decryptItemPrivate` is
 * stubbed to yield the real name so we assert the gate — not the crypto.
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
const SEEKER = 'seeker';
const PROVIDER = 'provider';
const ITEM_TYPE = 'profile_1.0';

// connect (seeker → provider) reveals PII only on `accepted`. The seeker schema
// carries a private `beneficiary_name`; the provider a public
// `organisation_name` display name (never masked — a control that proves the
// gate only touches the private side).
const NETWORK_CONFIG = {
  id: NETWORK,
  actions: {
    connect: {
      interactions: [
        {
          from_domain: SEEKER,
          to_domain: PROVIDER,
          from_items: [],
          to_items: [],
          reveals_pii_on_status: ['accepted'],
        },
      ],
    },
  },
  domains: [
    {
      id: SEEKER,
      item_schemas: {
        [ITEM_TYPE]: {
          type: 'object',
          properties: { beneficiary_name: { type: 'string', private: true } },
        },
      },
    },
    {
      id: PROVIDER,
      item_schemas: {
        [ITEM_TYPE]: {
          type: 'object',
          display_name_field: 'organisation_name',
          properties: { organisation_name: { type: 'string' } },
        },
      },
    },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => NETWORK_CONFIG),
}));

// The real name behind the "M***" mask — surfaced only when the gate reveals.
const REAL_NAME = 'Meera Kumari';
const MASKED_NAME = 'M***';

vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: vi.fn(() => ({ mergedState: { beneficiary_name: REAL_NAME } })),
}));

function makeChain(result: unknown[]) {
  const node: Record<string, unknown> = {
    from: vi.fn(() => node),
    where: vi.fn(() => node),
    orderBy: vi.fn(() => node),
    limit: vi.fn(() => node),
    offset: vi.fn(() => node),
    then: (resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(result).then(resolve, reject),
    catch: (reject: (e: unknown) => void) => Promise.resolve(result).catch(reject),
  };
  return node;
}

const dbState: { selectResults: unknown[][] } = { selectResults: [] };
let selectCallCount = 0;

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

const USER_ID = 'user_owner';
const OTHER_USER = 'user_counterparty';

const MY_ITEM_ID = '10000000-0000-4000-8000-000000000001'; // provider, owned by caller
const SEEKER_ITEM_ID = '20000000-0000-4000-8000-000000000002'; // seeker counterparty (private name)
const ACTION_ID = '51000000-0000-4000-8000-000000000001';

function makeActionRow(overrides: Record<string, unknown> = {}) {
  return {
    action_type: 'connect',
    partition_network: NETWORK,
    action_id: ACTION_ID,
    action_status: 'created',
    update_count: 0,
    source_item_network: NETWORK,
    source_item_domain: SEEKER,
    source_item_type: ITEM_TYPE,
    source_item_id: SEEKER_ITEM_ID,
    source_item_instance_url: 'http://source.local',
    source_item_owner: OTHER_USER,
    target_item_network: NETWORK,
    target_item_domain: PROVIDER,
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

function makeSeekerItem(overrides: Record<string, unknown> = {}) {
  return {
    item_id: SEEKER_ITEM_ID,
    item_network: NETWORK,
    item_domain: SEEKER,
    item_type: ITEM_TYPE,
    // maskPrivateState has already pre-masked the private field in item_state.
    item_state: { beneficiary_name: MASKED_NAME },
    item_locations: [] as Array<{ lat: number; lng: number }>,
    item_private_state: 'ciphertext-blob',
    lifecycle_status: 'live',
    ...overrides,
  };
}

const MY_ITEM = {
  item_id: MY_ITEM_ID,
  item_network: NETWORK,
  item_domain: PROVIDER,
  item_type: ITEM_TYPE,
  item_state: { organisation_name: 'Acme Org' },
  item_locations: [] as Array<{ lat: number; lng: number }>,
  item_private_state: null,
  lifecycle_status: 'live',
};

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

// Fast-path select order: count(*) -> rows -> resolveItemNames items query.
function queueFastPath(actionRow: unknown, items: unknown[]) {
  dbState.selectResults = [[{ count: 1 }], [actionRow], items];
}

beforeEach(() => {
  dbState.selectResults = [];
  selectCallCount = 0;
});

describe('GET /api/v1/action/fetch — PII name reveal gate (#439)', () => {
  it('masks the counterparty private name BEFORE accept (status not in reveals_pii_on_status)', async () => {
    queueFastPath(makeActionRow({ action_status: 'created' }), [makeSeekerItem(), MY_ITEM]);
    const app = await buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: '/fetch' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actions).toHaveLength(1);
    // Counterparty (source) name stays masked; the real name never leaves the server.
    expect(body.actions[0].source_item_name).toBe(MASKED_NAME);
    expect(res.payload).not.toContain(REAL_NAME);
    // Public provider name (target) is unaffected either way.
    expect(body.actions[0].target_item_name).toBe('Acme Org');
  });

  it('reveals the counterparty private name AFTER accept (status in reveals_pii_on_status) when the profile is live', async () => {
    queueFastPath(makeActionRow({ action_status: 'accepted' }), [makeSeekerItem(), MY_ITEM]);
    const app = await buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: '/fetch' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.actions[0].source_item_name).toBe(REAL_NAME);
    expect(body.actions[0].target_item_name).toBe('Acme Org');
  });

  it('keeps the name masked on an accepted action when the counterparty profile is NOT live (#273 live-gate)', async () => {
    queueFastPath(
      makeActionRow({ action_status: 'accepted' }),
      [makeSeekerItem({ lifecycle_status: 'paused' }), MY_ITEM],
    );
    const app = await buildApp({ id: USER_ID });
    const res = await app.inject({ method: 'GET', url: '/fetch' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // reveal status matches, but the profile is paused → still masked.
    expect(body.actions[0].source_item_name).toBe(MASKED_NAME);
    expect(res.payload).not.toContain(REAL_NAME);
  });
});
