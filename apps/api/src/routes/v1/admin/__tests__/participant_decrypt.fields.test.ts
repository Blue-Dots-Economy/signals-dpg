import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Unit tests for the #237 field-selection behaviour of
 * POST /api/v1/admin/participant/decrypt: when the request body carries
 * `fields`, each profile's `item_state` is replaced by
 * `selectRequestedFields`'s filtered output (see `utils/contact_fields.ts`);
 * when `fields` is omitted, the full merged `item_state` passes through
 * unchanged (today's behaviour — a regression guard).
 *
 * `participant_decrypt.test.ts` (colocated) covers request-validation and
 * acting-org gating without ever reaching the db query; this file exercises
 * the actual row → snapshot → field-selection path with a chained
 * `select().from().innerJoin().where()` db stub, modeled on
 * `aggregator/__tests__/dashboard.test.ts`'s `makeChain` helper — no real
 * Postgres/Redis needed.
 */

const state = {
  rows: [] as Array<Record<string, unknown>>,
  network_cfg: null as Record<string, unknown> | null,
};

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [{ network: 'blue_dot', domain: 'seeker' }],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    schema_registry_url: '',
  },
  authConfig: { secret: 'test-secret', middleware_enabled: false, url: '', create_test_otp: false },
  databasesConfig: { pg_url: 'postgres://localhost/test' },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  api: { API_DOMAIN: 'http://source.local', API_PORT: 3000 },
  auth: {}, databases: {}, matchScore: {}, notification: {},
  networkRuntime: {}, schemaRegistry: {},
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async (network: string) => {
    if (!state.network_cfg) throw new Error(`no network config fixture set for "${network}"`);
    return state.network_cfg;
  }),
}));

// item_decrypt is exercised by the integration test; a passthrough merge here
// keeps this file focused on field-selection, not decryption.
vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: (row: { item_state: Record<string, unknown> }) => ({ mergedState: row.item_state }),
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const makeChain = () => {
    const orderByChain = {
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(state.rows).then(onOk, onErr),
    };
    const whereChain = {
      orderBy: vi.fn(() => orderByChain),
      // Forward BOTH handlers so a rejecting resolve() surfaces to `await` as
      // a rejection instead of hanging the thenable.
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        Promise.resolve(state.rows).then(onOk, onErr),
    };
    const innerJoinChain = { where: vi.fn(() => whereChain) };
    const fromChain = { innerJoin: vi.fn(() => innerJoinChain) };
    return { from: vi.fn(() => fromChain) };
  };

  return {
    db: { select: vi.fn(() => makeChain()) },
  };
});

// Import the route AFTER mocks are set up.
import { participant_decrypt } from '../participant_decrypt.js';

async function buildApp(orgType: 'aggregator' | 'network_service' = 'network_service') {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (request) => {
    request.acting_org = { org_id: 'org_test', org_type: orgType, service_user_id: 'usr_test' };
  });
  await app.register(participant_decrypt);
  return app;
}

const item_id = '22222222-2222-4222-8222-222222222222';

const baseRow = (overrides: Record<string, unknown> = {}) => ({
  item_id,
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_state: { full_name: 'Real Name', mobile: '+911234567890', bio: 'hi' },
  item_private_state: 'irrelevant-ciphertext',
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-02T00:00:00Z'),
  user_name: 'Account Name',
  user_email: 'account@example.com',
  user_phone: '+910000000000',
  ...overrides,
});

const networkConfig = (domainOverrides: Record<string, unknown> = {}) => ({
  id: 'blue_dot',
  domains: [
    {
      id: 'seeker',
      item_schemas: {
        'profile_1.0': { display_name_field: 'full_name' },
      },
      card: { title_field: 'full_name' },
      contact_fields: { name: 'full_name', phone: 'mobile' }, // no `email` mapping
      ...domainOverrides,
    },
  ],
});

describe('POST /api/v1/admin/participant/decrypt — field selection (#237)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    state.rows = [];
    state.network_cfg = null;
    app = await buildApp();
  });

  it('fields omitted → full merged item_state, unchanged (regression)', async () => {
    state.rows = [baseRow()];
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].item_state).toEqual({
      full_name: 'Real Name',
      mobile: '+911234567890',
      bio: 'hi',
    });
  });

  it('fields: ["name","phone"] → only those keys, real (profile) values', async () => {
    state.rows = [baseRow()];
    state.network_cfg = networkConfig();
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], fields: ['name', 'phone'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].item_state).toEqual({
      name: 'Real Name',
      phone: '+911234567890',
    });
  });

  it('fields: ["email"] with no profile email → account email via fallback', async () => {
    state.rows = [
      baseRow({ item_state: { full_name: 'Real Name', mobile: '+911234567890' } }),
    ];
    state.network_cfg = networkConfig(); // no contact_fields.email mapping
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], fields: ['email'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].item_state).toEqual({ email: 'account@example.com' });
  });

  it('canonical field absent in both profile and account → null', async () => {
    state.rows = [
      baseRow({
        item_state: { full_name: 'Real Name', mobile: '+911234567890' },
        user_email: null,
      }),
    ];
    state.network_cfg = networkConfig(); // no contact_fields.email mapping
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], fields: ['email'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles).toHaveLength(1);
    expect(body.profiles[0].item_state).toEqual({ email: null });
  });
});
