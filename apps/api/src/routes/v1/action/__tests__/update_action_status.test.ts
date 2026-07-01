import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Task 5 — bulk POST /api/v1/action/update-status.
 * Each payload is an array; the route returns a { results, summary } envelope.
 */

// Single source of truth for the known action id used across mocks and test data.
const KNOWN_ACTION_ID = '00000000-0000-4000-8000-000000000aaa';

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

// --- mock drizzle: the handler does TWO selects on the db:
//   (1) item_actions row by action_id (existingAction lookup)
//   (2) user.onboarded_by_org_id (inside resolve_acting_actor — only when aggregator)
// We toggle between the two via a module-level counter.
const dbState: {
  userRows: Array<{ id: string; onboardedByOrgId: string | null }>;
  existingAction: Record<string, unknown> | null;
  updates: Array<Record<string, unknown>>;
  /** When set, each select call pops the next id and matches against EXISTING_ACTION.action_id. */
  actionIdQueue?: string[];
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
      //
      // For the mixed-batch test: dbState.resolvedIds tracks which action_ids have
      // been queried so far. On each no-projection select call, pop the next id from
      // dbState.resolvedIds. If the id matches EXISTING_ACTION.action_id, return the
      // existing action; otherwise return [].
      select: vi.fn((projection?: Record<string, unknown>) => {
        const isUserLookup =
          projection !== undefined && 'onboardedByOrgId' in projection;
        return {
          from: vi.fn(() => ({
            where: vi.fn(() => ({
              limit: vi.fn(() => {
                if (isUserLookup) return Promise.resolve(dbState.userRows);
                // Pop the next queried action_id from the queue if present.
                const nextId = dbState.actionIdQueue?.shift();
                if (nextId !== undefined) {
                  return Promise.resolve(
                    nextId === KNOWN_ACTION_ID && dbState.existingAction
                      ? [dbState.existingAction]
                      : [],
                  );
                }
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
      created_by: 'usr_agg_owned',
      item_id: 'target_item_1',
      item_locations: [],
      private_state: {},
      lifecycle_status: 'live',
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
    getActionInteraction: vi.fn(() => ({ event_schema: {}, reveals_pii_on_status: [] })),
  };
});

// Imported after mocks.
import { update_action_status } from '../update_action_status.js';

const EXISTING_ACTION = {
  action_id: KNOWN_ACTION_ID,
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
  target_item_owner: 'usr_agg_owned',
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
  request_user: { id: string } = { id: 'usr_agg_owned' },
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

describe('POST /api/v1/action/update-status (bulk, self-acted only)', () => {
  beforeEach(() => {
    dbState.userRows = [];
    dbState.existingAction = { ...EXISTING_ACTION };
    dbState.updates = [];
    dbState.actionIdQueue = undefined;
  });

  it('422 ACTION_NOT_FOUND when action_id does not resolve', async () => {
    dbState.existingAction = null;
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ status: 'error', error: 'ACTION_NOT_FOUND' });
  });

  it('422 NOT_TARGET_ITEM_OWNER when request.user is not the target owner', async () => {
    dbState.existingAction = { ...EXISTING_ACTION, target_item_owner: 'usr_other_provider' };
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ error: 'NOT_TARGET_ITEM_OWNER' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('422 PROFILE_NOT_LIVE when target item is not live', async () => {
    const { fetchLocalItemSnapshot } = await import('@/utils/action_event_runtime');
    (fetchLocalItemSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      created_by: 'usr_agg_owned',
      item_id: 'target_item_1',
      item_latitude: null,
      item_longitude: null,
      private_state: {},
      lifecycle_status: 'paused',
    });
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().results[0]).toMatchObject({ error: 'PROFILE_NOT_LIVE' });
    expect(dbState.updates).toHaveLength(0);
  });

  it('200 when self-acted by the target item owner', async () => {
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ total: 1, succeeded: 1, failed: 0 });
    expect(dbState.updates).toHaveLength(1);
    expect(dbState.updates[0]).toMatchObject({ action_status: 'shortlisted' });
  });

  it('UPDATE does NOT write performed_by_org_id or performed_by_service_user_id', async () => {
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [VALID_BODY],
    });
    expect(res.statusCode).toBe(200);
    const setPayload = dbState.updates[0];
    expect(setPayload).not.toHaveProperty('performed_by_org_id');
    expect(setPayload).not.toHaveProperty('performed_by_service_user_id');
  });

  it('acting_as_user_id in the body element has no effect (field removed from schema)', async () => {
    // Zod's default object behavior strips unknown keys; the route never
    // sees `acting_as_user_id`. With self-acted user_id matching the owner,
    // the request still succeeds.
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [{ ...VALID_BODY, acting_as_user_id: 'usr_other' }],
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.updates).toHaveLength(1);
  });

  it('207 on a mixed batch (one ok, one not found)', async () => {
    dbState.existingAction = { ...EXISTING_ACTION };
    // Drive per-item lookup: first element uses EXISTING_ACTION.action_id (found),
    // second uses an unknown id (not found).
    dbState.actionIdQueue = [
      EXISTING_ACTION.action_id,
      '00000000-0000-4000-8000-0000000000ff',
    ];
    const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
      method: 'POST',
      url: '/update-status',
      payload: [
        VALID_BODY,
        { action_id: '00000000-0000-4000-8000-0000000000ff', action_status: 'shortlisted' },
      ],
    });
    expect(res.statusCode).toBe(207);
    expect(res.json().summary).toEqual({ total: 2, succeeded: 1, failed: 1 });
    expect(res.json().results[0]).toMatchObject({ index: 0, status: 'success', action_id: KNOWN_ACTION_ID });
    expect(res.json().results[1]).toMatchObject({ status: 'error', error: 'ACTION_NOT_FOUND' });
  });

  describe('route-level request errors (short-circuit before db)', () => {
    it('400 BULK_EMPTY_ARRAY when body is an empty array', async () => {
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [],
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BULK_EMPTY_ARRAY' });
    });

    it('400 BULK_LIMIT_EXCEEDED when body exceeds bulk_max_items (100)', async () => {
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: Array.from({ length: 101 }, () => VALID_BODY),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'BULK_LIMIT_EXCEEDED' });
    });
  });

  describe('receiver consent gate', () => {
    it('422 CONSENT_REQUIRED when status is in reveals_pii_on_status but body has no consent', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        event_schema: {},
        reveals_pii_on_status: ['accepted'],
      });
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [
          {
            action_id: EXISTING_ACTION.action_id,
            action_status: 'accepted',
          },
        ],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'CONSENT_REQUIRED' });
      expect(dbState.updates).toHaveLength(0);
    });

    it('200 when status is NOT in reveals_pii_on_status (rejected does not need consent)', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        event_schema: {},
        reveals_pii_on_status: ['accepted'],
      });
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [
          {
            action_id: EXISTING_ACTION.action_id,
            action_status: 'rejected',
            remarks: 'not a fit',
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.succeeded).toBe(1);
      expect(dbState.updates).toHaveLength(1);
    });

    it('200 when consent and remarks both provided on an accepted action', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        event_schema: {},
        reveals_pii_on_status: ['accepted'],
      });
      const { buildActionEventPayload } = await import(
        '@/utils/action_event_runtime'
      );
      const buildSpy = buildActionEventPayload as ReturnType<typeof vi.fn>;
      buildSpy.mockReturnValueOnce({
        status: 'accepted',
        remark: 'looking forward',
        consent: {
          acknowledged: true,
          version: 1,
          consented_at: '2026-01-01T00:00:00.000Z',
        },
      });
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [
          {
            action_id: EXISTING_ACTION.action_id,
            action_status: 'accepted',
            remarks: 'looking forward',
            consent: { acknowledged: true, version: 1 },
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      // Verify buildActionEventPayload was called with consent
      expect(buildSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          consent: { acknowledged: true, version: 1 },
          remarks: 'looking forward',
        }),
      );
    });

    it('422 CONSENT_REQUIRED even when interaction has no consent_text_receiver but reveals_pii_on_status is set', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        event_schema: {},
        reveals_pii_on_status: ['accepted'],
        // no consent_text_receiver — required-ness comes from reveals_pii_on_status alone
      });
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [
          {
            action_id: EXISTING_ACTION.action_id,
            action_status: 'accepted',
            // no consent
          },
        ],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'CONSENT_REQUIRED' });
      expect(dbState.updates).toHaveLength(0);
    });

    it('200 back-compat — does NOT gate when reveals_pii_on_status is empty', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce({
        event_schema: {},
        reveals_pii_on_status: [],
      });
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [
          {
            action_id: EXISTING_ACTION.action_id,
            action_status: 'accepted',
          },
        ],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.succeeded).toBe(1);
      expect(dbState.updates).toHaveLength(1);
    });
  });

  describe('applicant cancellation (source-owner initiated)', () => {
    const CANCEL_INTERACTION = {
      event_schema: {},
      reveals_pii_on_status: [],
      metric_categories: { create: ['created'], accept: [], reject: [], cancel: ['cancelled'] },
    };
    const CANCEL_BODY = { action_id: EXISTING_ACTION.action_id, action_status: 'cancelled' };

    it('200 when the source item owner cancels a request the receiver has not acted on', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce(CANCEL_INTERACTION);
      dbState.existingAction = { ...EXISTING_ACTION, update_count: 0 };
      const res = await buildApp(undefined, { id: 'usr_seeker' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [CANCEL_BODY],
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().summary.succeeded).toBe(1);
      expect(dbState.updates).toHaveLength(1);
      expect(dbState.updates[0]).toMatchObject({ action_status: 'cancelled' });
    });

    it('422 RECEIVER_ALREADY_ACTED when the receiver has already acted (update_count > 0)', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce(CANCEL_INTERACTION);
      dbState.existingAction = { ...EXISTING_ACTION, update_count: 1 };
      const res = await buildApp(undefined, { id: 'usr_seeker' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [CANCEL_BODY],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'RECEIVER_ALREADY_ACTED' });
      expect(dbState.updates).toHaveLength(0);
    });

    it('422 NOT_SOURCE_ITEM_OWNER when a non-source owner (e.g. the receiver) tries to cancel', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce(CANCEL_INTERACTION);
      dbState.existingAction = { ...EXISTING_ACTION, update_count: 0 };
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [CANCEL_BODY],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'NOT_SOURCE_ITEM_OWNER' });
      expect(dbState.updates).toHaveLength(0);
    });

    it('422 ACTION_CANCELLED — receiver cannot accept an already-cancelled request', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce(CANCEL_INTERACTION);
      dbState.existingAction = { ...EXISTING_ACTION, action_status: 'cancelled', update_count: 1 };
      const res = await buildApp(undefined, { id: 'usr_agg_owned' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [{ action_id: EXISTING_ACTION.action_id, action_status: 'accepted' }],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'ACTION_CANCELLED' });
      expect(dbState.updates).toHaveLength(0);
    });

    it('422 ACTION_CANCELLED — source owner cannot re-cancel an already-cancelled request', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce(CANCEL_INTERACTION);
      dbState.existingAction = { ...EXISTING_ACTION, action_status: 'cancelled', update_count: 1 };
      const res = await buildApp(undefined, { id: 'usr_seeker' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [CANCEL_BODY],
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().results[0]).toMatchObject({ error: 'ACTION_CANCELLED' });
      expect(dbState.updates).toHaveLength(0);
    });

    it('200 cancellation is not gated on liveness (target item not live)', async () => {
      const { getActionInteraction } = await import('@dpg/schemas');
      (getActionInteraction as ReturnType<typeof vi.fn>).mockReturnValueOnce(CANCEL_INTERACTION);
      const { fetchLocalItemSnapshot } = await import('@/utils/action_event_runtime');
      (fetchLocalItemSnapshot as ReturnType<typeof vi.fn>).mockResolvedValue({
        created_by: 'usr_agg_owned',
        item_id: 'target_item_1',
        item_locations: [],
        private_state: {},
        lifecycle_status: 'paused',
      });
      dbState.existingAction = { ...EXISTING_ACTION, update_count: 0 };
      const res = await buildApp(undefined, { id: 'usr_seeker' }).inject({
        method: 'POST',
        url: '/update-status',
        payload: [CANCEL_BODY],
      });
      expect(res.statusCode).toBe(200);
      expect(dbState.updates).toHaveLength(1);
    });
  });
});
