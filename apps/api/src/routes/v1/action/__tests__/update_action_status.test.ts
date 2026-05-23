import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan A Task 6 — failing tests for POST /api/v1/action/update-status's
 * on-behalf-of behavior. The update_action_status route is mounted in
 * isolation (no acting_org preHandler, no auth middleware); the test
 * stubs `request.user` and `request.acting_org` via a custom preHandler
 * so the route's actor-resolution + audit persistence logic is exercised
 * independently of the surrounding wiring.
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

// --- mock drizzle: the handler does TWO selects on the db:
//   (1) item_actions row by action_id (existingAction lookup)
//   (2) user.onboarded_by_org_id (inside resolve_acting_actor — only when voice)
// We toggle between the two via a module-level counter.
const dbState: {
  userRows: Array<{ id: string; onboardedByOrgId: string | null }>;
  existingAction: Record<string, unknown> | null;
  updates: Array<Record<string, unknown>>;
} = {
  userRows: [],
  existingAction: null,
  updates: [],
};

vi.mock('@api/db/postgres/drizzle_config', () => {
  return {
    db: {
      // Discriminate by the shape of select's projection:
      //   - existingAction lookup uses `db.select()` (no args)        → returns existingAction row
      //   - resolve_acting_actor uses `db.select({ onboardedByOrgId })` → returns userRows
      select: vi.fn((projection?: Record<string, unknown>) => {
        const isUserLookup =
          projection !== undefined && 'onboardedByOrgId' in projection;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => {
                if (isUserLookup) return Promise.resolve(dbState.userRows);
                return Promise.resolve(
                  dbState.existingAction ? [dbState.existingAction] : [],
                );
              }),
            })),
          })),
        };
      }),
      update: vi.fn(() => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => ({
            returning: vi.fn(() => {
              dbState.updates.push(values);
              return Promise.resolve([
                {
                  ...(dbState.existingAction ?? {}),
                  ...values,
                  action_id: (dbState.existingAction as { action_id: string })
                    .action_id,
                },
              ]);
            }),
          })),
        })),
      })),
    },
  };
});

vi.mock('@dpg/database', async () => {
  const actual =
    await vi.importActual<typeof import('@dpg/database')>('@dpg/database');
  return {
    ...actual,
    ensureActionEventPartition: vi.fn(async () => undefined),
  };
});

vi.mock('@/utils/action_event_runtime', async () => {
  const actual = await vi.importActual<
    typeof import('@/utils/action_event_runtime')
  >('@/utils/action_event_runtime');
  return {
    ...actual,
    buildActionEventPayload: vi.fn(() => ({})),
    validateActionEventPayload: vi.fn(),
    insertActionEvent: vi.fn(async () => undefined),
    mirrorActionEventToSourceInstance: vi.fn(() => undefined),
    fetchLocalItemSnapshot: vi.fn(async () => ({
      created_by: 'usr_voice_owned',
      item_id: 'target_item_1',
      item_latitude: null,
      item_longitude: null,
      item_private_state: {},
    })),
  };
});

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
    getActionInteraction: vi.fn(() => ({ event_schema: {} })),
  };
});

// Imported after mocks.
import { update_action_status } from '../update_action_status.js';

const EXISTING_ACTION = {
  action_id: '00000000-0000-4000-8000-000000000aaa',
  action_type: 'apply',
  action_status: 'created',
  update_count: 0,
  remarks: null,
  source_item_network: 'blue_dot',
  source_item_domain: 'seeker',
  source_item_type: 'profile_1.0',
  source_item_id: '11111111-1111-4111-8111-111111111111',
  source_item_instance_url: 'http://source.local',
  source_item_owner: 'usr_seeker',
  target_item_network: 'blue_dot',
  target_item_domain: 'provider',
  target_item_type: 'job_posting_1.0',
  target_item_id: '22222222-2222-4222-8222-222222222222',
  target_item_instance_url: 'http://target.local',
  target_item_owner: 'usr_voice_owned',
  requirements_snapshot: {},
  performed_by_org_id: null,
  performed_by_service_user_id: null,
};

const VALID_BODY = {
  action_id: EXISTING_ACTION.action_id,
  action_status: 'shortlisted',
};

const buildApp = (
  acting_org?: unknown,
  request_user: { id: string } = { id: 'usr_voice_owned' },
): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { user: typeof request_user }).user = request_user;
    if (acting_org)
      (req as unknown as { acting_org: unknown }).acting_org = acting_org;
  });
  app.register(update_action_status);
  return app;
};

describe('POST /api/v1/action/update-status — on-behalf-of', () => {
  beforeEach(() => {
    dbState.userRows = [];
    dbState.existingAction = { ...EXISTING_ACTION };
    dbState.updates = [];
  });

  it('self-acted: no acting_org, no body field → 200, audit fields null', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      performed_by_org_id: null,
      performed_by_service_user_id: null,
    });
  });

  it('400 CANNOT_OVERRIDE_SELF when body field present but no acting_org', async () => {
    const app = buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_other' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'CANNOT_OVERRIDE_SELF' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('400 MISSING_ACTING_AS_USER_ID with voice acting_org and no body field', async () => {
    const app = buildApp({
      org_id: 'org_voice_1',
      org_type: 'voice',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: 'MISSING_ACTING_AS_USER_ID' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('403 ACTING_ORG_TYPE_NOT_ALLOWED for aggregator', async () => {
    const app = buildApp({
      org_id: 'org_agg',
      org_type: 'aggregator',
      service_user_id: 'svc_agg',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('403 NOT_AUTHORIZED_FOR_TARGET when target onboarded by another voice org', async () => {
    dbState.userRows = [
      { id: 'usr_voice_owned', onboardedByOrgId: 'org_voice_2' },
    ];
    const app = buildApp({
      org_id: 'org_voice_1',
      org_type: 'voice',
      service_user_id: 'svc',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: 'NOT_AUTHORIZED_FOR_TARGET' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('voice happy path: writes audit fields to the UPDATE', async () => {
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
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({
      performed_by_org_id: 'org_voice_1',
      performed_by_service_user_id: 'svc_voice_1',
    });
  });

  it('logs WARN when overwriting on-behalf-of audit fields with a different voice org', async () => {
    dbState.userRows = [
      { id: 'usr_voice_owned', onboardedByOrgId: 'org_voice_1' },
    ];
    dbState.existingAction = {
      ...EXISTING_ACTION,
      performed_by_org_id: 'org_voice_2',
      performed_by_service_user_id: 'svc_voice_2',
    };
    const warnSpy = vi.fn();
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.addHook('preHandler', async (req) => {
      (req as unknown as { user: { id: string } }).user = {
        id: 'usr_voice_owned',
      };
      (req as unknown as { acting_org: unknown }).acting_org = {
        org_id: 'org_voice_1',
        org_type: 'voice',
        service_user_id: 'svc_voice_1',
      };
      (req as unknown as { log: unknown }).log = {
        warn: warnSpy,
        error: vi.fn(),
        info: vi.fn(),
        debug: vi.fn(),
        fatal: vi.fn(),
        trace: vi.fn(),
        child: vi.fn(() => (req as unknown as { log: unknown }).log),
      };
    });
    app.register(update_action_status);

    const res = await app.inject({
      method: 'POST',
      url: '/update-status',
      payload: { ...VALID_BODY, acting_as_user_id: 'usr_voice_owned' },
    });

    expect(res.statusCode).toBe(200);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatchObject({
      action_id: EXISTING_ACTION.action_id,
      acting_org_id: 'org_voice_1',
      previous_performed_by_org_id: 'org_voice_2',
      new_performed_by_org_id: 'org_voice_1',
    });
  });
});
