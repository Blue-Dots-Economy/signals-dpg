import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan A Task 6 — bulk POST /api/v1/action/perform.
 * Each test sends an array body and asserts the { results, summary } envelope.
 */

// --- mock @/config so the env-validating loadEnv() never runs in tests ---
vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [],
    network_config_source: 'local',
    network_config_local_file: '',
    network_config_urls: [],
    allow_extra_schema_data: true,
    bulk_max_items: 100,
    schema_registry_url: '',
  },
  authConfig: {
    secret: 'test-secret',
    middleware_enabled: false,
    url: 'http://source.local/api/auth',
    create_test_otp: false,
  },
  matchScoreConfig: { provider: 'noop', dpg_scoring: {} },
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

// --- mock @/routes/auth/create_auth so the auth_middleware import chain
//     doesn't try to resolve @dpg/auth at module load time ---
vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: {
    api: {
      getSession: vi.fn(async () => null),
    },
    handler: vi.fn(),
  },
}));

// --- mock the auth middleware itself so the auth path is a no-op in tests ---
vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

// --- mock @api/db/postgres/drizzle_config: db.select for onboarded_by lookup ---
const dbState: {
  userRows: Array<{ id: string; onboardedByOrgId: string | null }>;
} = {
  userRows: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  // The route does TWO selects via db.select():
  //   (a) `resolve_acting_actor` looks up user.onboarded_by_org_id (only
  //       when acting_org is aggregator) — returns dbState.userRows.
  //   (b) `fetchLocalItemSnapshot` is itself mocked below, so the second
  //       select is never actually invoked through this mock. We still
  //       toggle to keep the mock shape generic, but the only call we
  //       care about returns userRows.
  return {
    db: {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(() => Promise.resolve(dbState.userRows)),
          })),
        })),
      })),
    },
  };
});

// --- mock fetch() so the proxy hop returns a deterministic response ---
const fetchCalls: Array<{ url: string; body: any }> = [];
const fetchResponse: { status: number; body: Record<string, unknown> } = {
  status: 201,
  body: {
    action_id: '00000000-0000-0000-0000-000000000001',
    action_type: 'apply',
    action_status: 'created',
    update_count: 0,
    source_item_id: '11111111-1111-4111-8111-111111111111',
    target_item_id: '22222222-2222-4222-8222-222222222222',
  },
};
vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string | URL, init: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      body: JSON.parse(init.body as string),
    });
    return new Response(JSON.stringify(fetchResponse.body), {
      status: fetchResponse.status,
      headers: { 'content-type': 'application/json' },
    });
  }),
);

// --- mock helpers from action_event_runtime: only fetchLocalItemSnapshot is on the perform path ---
const { fetchLocalItemSnapshotMock } = vi.hoisted(() => ({
  fetchLocalItemSnapshotMock: vi.fn(async () => ({
    created_by: 'usr_agg_owned',
    item_id: 'src_item_1',
    item_latitude: null,
    item_longitude: null,
    private_state: {},
  })),
}));

vi.mock('@/utils/action_event_runtime', async () => {
  const actual =
    await vi.importActual<typeof import('@/utils/action_event_runtime')>(
      '@/utils/action_event_runtime',
    );
  return {
    ...actual,
    fetchLocalItemSnapshot: fetchLocalItemSnapshotMock,
  };
});

// --- mock served domain guard so the test isn't sensitive to env config ---
vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: () => true,
  replyForUnservedDomain: vi.fn(),
}));

// --- mock network config + interaction lookup ---
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    domains: [{ id: 'provider' }],
    instances: [
      { domain_id: 'provider', instance_url: 'http://target.local' },
    ],
  })),
}));

vi.mock('@dpg/schemas', async () => {
  const actual =
    await vi.importActual<typeof import('@dpg/schemas')>('@dpg/schemas');
  return {
    ...actual,
    getActionInteraction: vi.fn(() => ({
      requirement_schema: {
        type: 'object',
        properties: {},
        additionalProperties: true,
      },
    })),
    validateAgainstJsonSchema: vi.fn(),
    mergeItemStateWithPrivate: vi.fn((a: any) => a),
    projectPrivateStateForSchema: vi.fn(() => ({})),
  };
});

// Imported after mocks.
import { perform_action } from '../perform_action.js';

// Valid v4 UUIDs (the "4" in the third group and "8/9/a/b" in the fourth
// satisfy z.uuid() across zod variants that gate on the variant nibble).
const SRC_ITEM_ID = '11111111-1111-4111-8111-111111111111';
const TGT_ITEM_ID = '22222222-2222-4222-8222-222222222222';

const VALID_BODY = {
  action_type: 'apply',
  source_item: {
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile_1.0',
    item_id: SRC_ITEM_ID,
  },
  target_item: {
    item_network: 'blue_dot',
    item_domain: 'provider',
    item_type: 'job_posting_1.0',
    item_id: TGT_ITEM_ID,
    item_instance_url: 'http://target.local',
  },
  requirements_snapshot: {},
};

const buildApp = (
  acting_org?: any,
  request_user: { id: string } = { id: 'usr_agg_owned' },
): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as any).user = request_user;
    if (acting_org) (req as any).acting_org = acting_org;
  });
  app.register(perform_action);
  return app;
};

describe('POST /api/v1/action/perform — on-behalf-of (bulk)', () => {
  beforeEach(() => {
    dbState.userRows = [];
    fetchCalls.length = 0;
    // Reset snapshot mock to the default valid snapshot
    fetchLocalItemSnapshotMock.mockResolvedValue({
      created_by: 'usr_agg_owned',
      item_id: 'src_item_1',
      item_latitude: null,
      item_longitude: null,
      private_state: {},
    });
    // Reset fetchResponse to default success
    fetchResponse.status = 201;
    fetchResponse.body = {
      action_id: '00000000-0000-0000-0000-000000000001',
      action_type: 'apply',
      action_status: 'created',
      update_count: 0,
      source_item_id: '11111111-1111-4111-8111-111111111111',
      target_item_id: '22222222-2222-4222-8222-222222222222',
    };
  });

  it('self-acted: no acting_org, no body field → 201, summary.succeeded=1, forwards effective_user_id as source_item_owner, audit null', async () => {
    // The snapshot's created_by is "usr_agg_owned" — match request.user
    // so the SOURCE_ITEM_NOT_OWNED_BY_ACTOR guard does not trip.
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({
      index: 0,
      status: 'success',
      action_id: '00000000-0000-0000-0000-000000000001',
      action_type: 'apply',
      action_status: 'created',
      update_count: 0,
      source_item_id: SRC_ITEM_ID,
      target_item_id: TGT_ITEM_ID,
    });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_agg_owned',
      performed_by_org_id: null,
      performed_by_service_user_id: null,
    });
  });

  it('422 CANNOT_OVERRIDE_SELF when body field present but no acting_org', async () => {
    const app = buildApp(undefined, { id: 'usr_self' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_target' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'CANNOT_OVERRIDE_SELF' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 MISSING_ACTING_AS_USER_ID when aggregator acting_org but no body field', async () => {
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'MISSING_ACTING_AS_USER_ID' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 ACTING_ORG_TYPE_NOT_ALLOWED for voice acting_org', async () => {
    const app = buildApp({
      org_id: 'org_voice_1',
      org_type: 'voice',
      service_user_id: 'svc_voice_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_target' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 NOT_AUTHORIZED_FOR_TARGET when target onboarded by another aggregator', async () => {
    dbState.userRows = [
      { id: 'usr_other', onboardedByOrgId: 'org_agg_2' },
    ];
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_other' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'NOT_AUTHORIZED_FOR_TARGET' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('aggregator happy path: 201, forwards acting_as_user_id as source_item_owner + populates audit', async () => {
    dbState.userRows = [
      { id: 'usr_agg_owned', onboardedByOrgId: 'org_agg_1' },
    ];
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc_agg_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' }],
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(body.results[0]).toMatchObject({ status: 'success' });
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_agg_owned',
      performed_by_org_id: 'org_agg_1',
      performed_by_service_user_id: 'svc_agg_1',
    });
  });

  it('422 SOURCE_ITEM_NOT_OWNED_BY_ACTOR when snapshot.created_by != effective_user_id', async () => {
    dbState.userRows = [
      { id: 'usr_agg_owned', onboardedByOrgId: 'org_agg_1' },
    ];
    // Override the snapshot mock to return a DIFFERENT owner than acting_as_user_id.
    fetchLocalItemSnapshotMock.mockResolvedValue({
      created_by: 'usr_someone_else',
      item_id: 'src_item_1',
      item_latitude: null,
      item_longitude: null,
      private_state: {},
    });
    const app = buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
      service_user_id: 'svc_agg_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_agg_owned' }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'SOURCE_ITEM_NOT_OWNED_BY_ACTOR' });
    expect(fetchCalls).toHaveLength(0); // proxy hop must be skipped
  });

  it('422 SOURCE_ITEM_NOT_FOUND when snapshot returns null', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fetchLocalItemSnapshotMock.mockResolvedValue(null as any);
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'SOURCE_ITEM_NOT_FOUND' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('422 INVALID_TARGET_INSTANCE when target instance URL is not in the network config', async () => {
    const app = buildApp(undefined, { id: 'usr_agg_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: [{ ...VALID_BODY, target_item: { ...VALID_BODY.target_item, item_instance_url: 'http://not-allowed.local' } }],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'INVALID_TARGET_INSTANCE' });
    expect(fetchCalls).toHaveLength(0);
  });

  describe('initiator consent gate', () => {
    it('422 CONSENT_REQUIRED when interaction declares consent_text_initiator but body has no consent', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        requirement_schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        consent_text_initiator: 'I agree to share my PII.',
      });
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [VALID_BODY], // no consent field
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'CONSENT_REQUIRED' });
      expect(fetchCalls).toHaveLength(0);
    });

    it('201, forwards consent block to /network/action/perform when supplied', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        requirement_schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        consent_text_initiator: 'I agree.',
      });
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [
          {
            ...VALID_BODY,
            consent: { acknowledged: true, text: 'I agree.' },
          },
        ],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.summary.succeeded).toBe(1);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body.consent).toEqual({
        acknowledged: true,
        text: 'I agree.',
      });
    });

    it('does NOT gate when interaction has no consent_text_initiator (back-compat)', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        requirement_schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        consent_text_initiator: undefined,
      });
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [VALID_BODY], // no consent field
      });
      expect(res.statusCode).toBe(201);
      expect(fetchCalls).toHaveLength(1);
    });
  });

  describe('network_service tier', () => {
    it('network_service on-behalf-of: 201 when acting for any user in the network', async () => {
      dbState.userRows = [
        { id: 'usr_voice_owned', onboardedByOrgId: 'org_agg_b' },
      ];
      fetchLocalItemSnapshotMock.mockResolvedValue({
        created_by: 'usr_voice_owned',
        item_id: 'src_item_1',
        item_latitude: null,
        item_longitude: null,
        private_state: {},
      });
      const app = buildApp({
        org_id: 'org_signals',
        org_type: 'network_service',
        service_user_id: 'svc_ns',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' }],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.summary.succeeded).toBe(1);
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].body).toMatchObject({
        source_item_owner: 'usr_voice_owned',
        performed_by_org_id: 'org_signals',
        performed_by_service_user_id: 'svc_ns',
      });
    });

    it('network_service on-behalf-of: 201 for self-registered user (onboarded_by null)', async () => {
      dbState.userRows = [
        { id: 'usr_self_reg', onboardedByOrgId: null },
      ];
      fetchLocalItemSnapshotMock.mockResolvedValue({
        created_by: 'usr_self_reg',
        item_id: 'src_item_1',
        item_latitude: null,
        item_longitude: null,
        private_state: {},
      });
      const app = buildApp({
        org_id: 'org_signals',
        org_type: 'network_service',
        service_user_id: 'svc_ns',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_self_reg' }],
      });
      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.summary.succeeded).toBe(1);
      expect(fetchCalls[0].body).toMatchObject({
        source_item_owner: 'usr_self_reg',
        performed_by_org_id: 'org_signals',
      });
    });

    it('network_service on-behalf-of: 422 USER_NOT_FOUND when pointing at non-existent user', async () => {
      dbState.userRows = []; // empty — no row returned
      const app = buildApp({
        org_id: 'org_signals',
        org_type: 'network_service',
        service_user_id: 'svc_ns',
      });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_missing' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'USER_NOT_FOUND' });
      expect(fetchCalls).toHaveLength(0);
    });
  });

  describe('mixed batch', () => {
    it('207 when one connect succeeds and one has an unknown target instance', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [
          VALID_BODY,
          { ...VALID_BODY, target_item: { ...VALID_BODY.target_item, item_instance_url: 'http://not-allowed.local' } },
        ],
      });
      expect(res.statusCode).toBe(207);
      const body = res.json();
      expect(body.summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
      expect(body.results[0]).toMatchObject({ index: 0, status: 'success' });
      expect(body.results[1]).toMatchObject({ index: 1, status: 'error', error: 'INVALID_TARGET_INSTANCE' });
    });
  });

  describe('request-level bulk guards', () => {
    it('400 BULK_EMPTY_ARRAY for an empty array', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BULK_EMPTY_ARRAY' });
    });

    it('400 BULK_LIMIT_EXCEEDED when over the configured max', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      // Generate 101 items (bulk_max_items is mocked to 100)
      const items = Array.from({ length: 101 }, () => VALID_BODY);
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: items,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BULK_LIMIT_EXCEEDED' });
    });
  });

  describe('remote error handling', () => {
    it('422 DUPLICATE_ACTION when target instance responds non-OK with a structured error body', async () => {
      fetchResponse.status = 409;
      fetchResponse.body = { error: 'DUPLICATE_ACTION', message: 'already exists' };
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [VALID_BODY],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'DUPLICATE_ACTION' });
    });

    it('422 INVALID_PAYLOAD when item is missing required source_item/target_item/requirements_snapshot', async () => {
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [{ action_type: 'connect' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'INVALID_PAYLOAD' });
      expect(fetchCalls).toHaveLength(0);
    });

    it('422 TARGET_INSTANCE_UNAVAILABLE when target instance returns a non-JSON body (Fix 1)', async () => {
      const originalFetch = vi.mocked(global.fetch);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string | URL, init: RequestInit) => {
          fetchCalls.push({ url: String(url), body: JSON.parse(init.body as string) });
          return {
            ok: true,
            json: async () => { throw new SyntaxError('Unexpected token <'); },
          } as unknown as Response;
        }),
      );
      const app = buildApp(undefined, { id: 'usr_agg_owned' });
      const res = await app.inject({
        method: 'POST',
        url: '/perform',
        payload: [VALID_BODY],
      });
      // Restore normal fetch mock
      vi.stubGlobal('fetch', originalFetch);
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'TARGET_INSTANCE_UNAVAILABLE' });
    });
  });
});
