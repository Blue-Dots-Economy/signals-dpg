import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Unit tests for the #521 reshape of POST /api/v1/admin/participant/decrypt's
 * `fields` / `contact` / `include_locations` controls (decoupled per
 * docs/superpowers/specs/2026-08-07-participant-decrypt-field-resolution-design.md):
 *
 *  - `fields` (present) => a PURE `item_state` projection (raw keys only, no
 *    canonical special-casing, no `user` fallback); omitted => full
 *    `item_state` (regression guard).
 *  - `contact` (independent of `fields`) => a `contact` block resolved via
 *    the domain contact_fields map + account fallback, with provenance.
 *  - `include_locations` => a `locations` array from the item's
 *    `item_locations` column.
 *
 * `participant_decrypt.test.ts` (colocated) covers request-validation and
 * acting-org gating without ever reaching the db query; this file exercises
 * the actual row → snapshot path with a chained
 * `select().from().innerJoin().where()` db stub, modeled on
 * `aggregator/__tests__/dashboard.test.ts`'s `makeChain` helper — no real
 * Postgres/Redis needed.
 */

const state = {
  rows: [] as Array<Record<string, unknown>>,
  network_cfg: null as Record<string, unknown> | null,
  // #237 review fix: when set, the config-lookup mock rejects instead of
  // resolving/throwing-not-configured, simulating a transient failure (e.g.
  // schema-registry fetch) rather than a missing-network configuration error.
  network_cfg_reject: false,
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
    if (state.network_cfg_reject) {
      throw new Error(`transient config load failure for "${network}"`);
    }
    if (!state.network_cfg) throw new Error(`no network config fixture set for "${network}"`);
    return state.network_cfg;
  }),
}));

// item_decrypt is exercised by the integration test; a passthrough merge here
// keeps this file focused on field/contact/locations resolution, not decryption.
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
  item_locations: [{ lat: 12.9, lng: 77.5, label: 'Bengaluru' }],
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

describe('POST /api/v1/admin/participant/decrypt — field/contact/locations resolution (#521)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    state.rows = [];
    state.network_cfg = null;
    state.network_cfg_reject = false;
    app = await buildApp();
  });

  it('fields/contact/include_locations all omitted → identical full item_state, no extra keys (regression)', async () => {
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
    expect(body.profiles[0]).not.toHaveProperty('contact');
    expect(body.profiles[0]).not.toHaveProperty('locations');
  });

  it('fields: ["bio"] → a pure item_state projection, no canonical mapping applied', async () => {
    state.rows = [baseRow()];
    // No network_cfg fixture set at all: proves the fields path never calls
    // getNetworkConfigById (it would throw "no network config fixture set").
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], fields: ['bio', 'full_name'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].item_state).toEqual({ bio: 'hi', full_name: 'Real Name' });
    expect(body.profiles[0]).not.toHaveProperty('contact');
  });

  it('fields requesting the canonical key "name" reads it raw (no mapping, no user fallback)', async () => {
    // The domain maps canonical name -> full_name, but `fields` never applies
    // that mapping: item_state has no literal `name` key, so it's omitted.
    state.rows = [baseRow()];
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], fields: ['name'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].item_state).toEqual({});
  });

  it('contact: true (no fields) → full item_state PLUS a contact block with all three', async () => {
    state.rows = [baseRow()];
    state.network_cfg = networkConfig();
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], contact: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].item_state).toEqual({
      full_name: 'Real Name',
      mobile: '+911234567890',
      bio: 'hi',
    });
    expect(body.profiles[0].contact).toEqual({
      name: { value: 'Real Name', source: 'item' },
      phone: { value: '+911234567890', source: 'item' },
      email: { value: 'account@example.com', source: 'user' }, // no email mapping → account fallback
    });
  });

  it('contact subset ["phone"] → only phone in the block', async () => {
    state.rows = [baseRow()];
    state.network_cfg = networkConfig();
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], contact: ['phone'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].contact).toEqual({
      phone: { value: '+911234567890', source: 'item' },
    });
  });

  it('contact + fields together: fields is a raw projection, contact is the normalized/provenanced answer', async () => {
    state.rows = [baseRow()];
    state.network_cfg = networkConfig();
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], fields: ['bio'], contact: ['email'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].item_state).toEqual({ bio: 'hi' });
    expect(body.profiles[0].contact).toEqual({
      email: { value: 'account@example.com', source: 'user' },
    });
  });

  it('canonical field absent in both profile and account → {value:null, source:null}', async () => {
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
      payload: { item_ids: [item_id], contact: ['email'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].contact).toEqual({ email: { value: null, source: null } });
  });

  it('include_locations: true → locations present from item_locations', async () => {
    state.rows = [baseRow()];
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], include_locations: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].locations).toEqual([{ lat: 12.9, lng: 77.5, label: 'Bengaluru' }]);
  });

  it('include_locations omitted/false → no locations key', async () => {
    state.rows = [baseRow()];
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], include_locations: false },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0]).not.toHaveProperty('locations');
  });

  it('full combination: fields + contact + include_locations all together', async () => {
    state.rows = [baseRow()];
    state.network_cfg = networkConfig();
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], fields: ['bio'], contact: true, include_locations: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.profiles[0].item_state).toEqual({ bio: 'hi' });
    expect(body.profiles[0].contact.name).toEqual({ value: 'Real Name', source: 'item' });
    expect(body.profiles[0].locations).toEqual([{ lat: 12.9, lng: 77.5, label: 'Bengaluru' }]);
  });

  it('#237/#521 review fix: config-lookup rejection degrades the row instead of 500ing the request', async () => {
    state.rows = [baseRow()];
    state.network_cfg_reject = true; // getNetworkConfigById rejects for every network
    const res = await app.inject({
      method: 'POST',
      url: '/participant/decrypt',
      payload: { item_ids: [item_id], contact: ['name', 'phone'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.skipped).toEqual([]);
    expect(body.profiles).toHaveLength(1);
    // No usable context (config lookup failed) → canonical fields fall back
    // to the account row rather than the real profile values.
    expect(body.profiles[0].contact).toEqual({
      name: { value: 'Account Name', source: 'user' },
      phone: { value: '+910000000000', source: 'user' },
    });
  });
});
