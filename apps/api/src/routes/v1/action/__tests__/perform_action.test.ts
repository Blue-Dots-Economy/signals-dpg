import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan A Task 5 — failing tests for POST /api/v1/action/perform's
 * on-behalf-of behavior. The perform_action route is mounted in
 * isolation (no acting_org preHandler, no auth middleware); the test
 * stubs `request.user` and `request.acting_org` via a custom
 * preHandler so the route's actor-resolution + audit propagation
 * logic is exercised independently of the surrounding wiring.
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
  //       when acting_org is voice) — returns dbState.userRows.
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
vi.mock('@/utils/action_event_runtime', async () => {
  const actual =
    await vi.importActual<typeof import('@/utils/action_event_runtime')>(
      '@/utils/action_event_runtime',
    );
  return {
    ...actual,
    fetchLocalItemSnapshot: vi.fn(async () => ({
      created_by: 'usr_voice_owned',
      item_id: 'src_item_1',
      item_latitude: null,
      item_longitude: null,
      item_private_state: {},
    })),
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
  request_user: { id: string } = { id: 'usr_voice_owned' },
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

describe('POST /api/v1/action/perform — on-behalf-of', () => {
  beforeEach(() => {
    dbState.userRows = [];
    fetchCalls.length = 0;
  });

  it('self-acted: no acting_org, no body field → forwards effective_user_id as source_item_owner, audit null', async () => {
    // The snapshot's created_by is "usr_voice_owned" — match request.user
    // so the SOURCE_ITEM_NOT_OWNED_BY_ACTOR guard does not trip.
    const app = buildApp(undefined, { id: 'usr_voice_owned' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_voice_owned',
      performed_by_org_id: null,
      performed_by_service_user_id: null,
    });
  });

  it('400 CANNOT_OVERRIDE_SELF when body field present but no acting_org', async () => {
    const app = buildApp(undefined, { id: 'usr_self' });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_target' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'CANNOT_OVERRIDE_SELF' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('400 MISSING_ACTING_AS_USER_ID when voice acting_org but no body field', async () => {
    const app = buildApp({
      org_id: 'org_voice_1',
      org_type: 'voice',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'MISSING_ACTING_AS_USER_ID' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('403 ACTING_ORG_TYPE_NOT_ALLOWED for aggregator acting_org', async () => {
    const app = buildApp({
      org_id: 'org_agg',
      org_type: 'aggregator',
      service_user_id: 'svc_agg',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_target' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('403 NOT_AUTHORIZED_FOR_TARGET when target onboarded by another voice org', async () => {
    dbState.userRows = [
      { id: 'usr_other', onboardedByOrgId: 'org_voice_2' },
    ];
    const app = buildApp({
      org_id: 'org_voice_1',
      org_type: 'voice',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_other' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'NOT_AUTHORIZED_FOR_TARGET' });
    expect(fetchCalls).toHaveLength(0);
  });

  it('voice happy path: forwards acting_as_user_id as source_item_owner + populates audit', async () => {
    dbState.userRows = [
      { id: 'usr_voice_owned', onboardedByOrgId: 'org_voice_1' },
    ];
    const app = buildApp({
      org_id: 'org_voice_1',
      org_type: 'voice',
      service_user_id: 'svc_voice_1',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/perform',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(201);
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].body).toMatchObject({
      source_item_owner: 'usr_voice_owned',
      performed_by_org_id: 'org_voice_1',
      performed_by_service_user_id: 'svc_voice_1',
    });
  });
});
