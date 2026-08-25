import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * §11 integration test — UPDATE seam (POST /api/v1/action/update-status).
 *
 * Proves the notification dispatch can't break the status response:
 *   (a) the action returns 200 even when `nc.notify` rejects, and
 *   (b) `insertActionEvent` is called exactly once (no double insert from
 *       the dispatch path).
 *
 * Notifications are configured (unlike update_action_status.test.ts, which
 * stubs `notification: {}`) so the real dispatch runs and reaches the throwing
 * notify client.
 */

const KNOWN_ACTION_ID = '00000000-0000-4000-8000-000000000aaa';

// Shared with vi.mock factories (hoisted above top-level consts).
const { notifySpy, insertActionEventSpy } = vi.hoisted(() => ({
  notifySpy: vi.fn(async () => {
    throw new Error('NS down');
  }),
  insertActionEventSpy: vi.fn(async () => ({
    event_id: 'evt_1',
    action_id: '00000000-0000-4000-8000-000000000aaa',
    action_type: 'apply',
    action_status: 'shortlisted',
    update_count: 1,
  })),
}));

vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [],
    allow_extra_schema_data: true,
    bulk_max_items: 100,
    schema_registry_url: '',
  },
  authConfig: { secret: 'test', middleware_enabled: false, url: '', create_test_otp: false },
  matchScoreConfig: { provider: 'noop', signals_search: {} },
  getCurrentApiBaseUrl: () => 'http://source.local',
  instance: { INSTANCE_NAME: 'test', INSTANCE_ENV: 'development' },
  notification: {
    NOTIFICATION_FROM_EMAIL: 'from@test.local',
    NOTIFICATION_REPLY_TO: 'reply@test.local',
    FRONTEND_BASE_URL: 'http://fe.test',
  },
  uiHostBindings: { byDomain: {}, warnings: [] },
}));

vi.mock('@/utils/notificationClient', () => ({
  getNotificationClient: () => ({ notify: notifySpy }),
}));

vi.mock('@/notifications/resolve_owner', () => ({
  resolveOwnerEmail: vi.fn(async () => 'recipient@test.local'),
  resolveProviderServiceName: vi.fn(async () => 'Acme Services'),
}));

vi.mock('@/routes/auth/create_auth', () => ({
  authInstance: { api: { getSession: vi.fn(async () => null) }, handler: vi.fn() },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

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
  target_item_instance_url: 'http://source.local',
  target_item_owner: 'usr_provider',
  requirements_snapshot: {},
  performed_by_org_id: null,
  performed_by_service_user_id: null,
};

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: vi.fn(async () => 1),
}));

// --- U18 guardian gate seam: this suite's fixtures never trigger
// `requiresReceiverConsent` (reveals_pii_on_status is []), but the route
// module still imports guardian_action_gate at load time, which otherwise
// pulls in the real Redis client against this suite's minimal @/config mock.
// Same seam Task 2 added when wiring the gate into perform_action.
vi.mock('@/services/guardian_action_gate', () => ({
  guardianActionGate: vi.fn(async () => ({ status: 'not_required' })),
  // Gate is always not_required in these tests, so the mapper only ever returns null.
  guardianGateFailure: () => null,
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const dbMock: Record<string, unknown> = {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => [EXISTING_ACTION]),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => ({
          returning: vi.fn(async () => [
            { ...EXISTING_ACTION, ...values, update_count: 1 },
          ]),
        })),
      })),
    })),
    insert: vi.fn(() => ({ values: vi.fn(() => Promise.resolve(undefined)) })),
  };
  dbMock.transaction = vi.fn(async (cb: (tx: unknown) => unknown) => cb(dbMock));
  return { db: dbMock };
});

vi.mock('@dpg/database', async () => {
  const actual =
    await vi.importActual<typeof import('@dpg/database')>('@dpg/database');
  return { ...actual, ensureActionEventPartition: vi.fn(async () => undefined) };
});

vi.mock('@/utils/action_event_runtime', async () => {
  const actual = await vi.importActual<
    typeof import('@/utils/action_event_runtime')
  >('@/utils/action_event_runtime');
  return {
    ...actual,
    buildActionEventPayload: vi.fn(() => ({})),
    validateActionEventPayload: vi.fn(),
    insertActionEvent: insertActionEventSpy,
    mirrorActionEventToSourceInstance: vi.fn(() => undefined),
    fetchLocalItemSnapshot: vi.fn(async () => ({
      created_by: 'usr_provider',
      item_id: '22222222-2222-4222-8222-222222222222',
      item_locations: [],
      private_state: {},
      lifecycle_status: 'live',
    })),
  };
});

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'blue_dot',
    display_name: 'Blue Dot',
    domains: [{ id: 'provider' }],
    instances: [{ domain_id: 'provider', instance_url: 'http://source.local' }],
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

const VALID_BODY = { action_id: KNOWN_ACTION_ID, action_status: 'shortlisted' };

const buildApp = (): FastifyInstance => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { user: { id: string } }).user = { id: 'usr_provider' };
  });
  app.register(update_action_status);
  return app;
};

describe('POST /api/v1/action/update-status — notification fire-and-forget', () => {
  beforeEach(() => {
    notifySpy.mockClear();
    insertActionEventSpy.mockClear();
  });

  it('returns 200 even when nc.notify rejects, and inserts the event exactly once', async () => {
    const res = await buildApp().inject({
      method: 'POST',
      url: '/update-status',
      payload: [VALID_BODY],
    });

    // (a) The status update succeeds despite the notification client throwing.
    expect(res.statusCode).toBe(200);
    expect(res.json().summary).toEqual({ total: 1, succeeded: 1, failed: 0 });

    // (b) Exactly one insertActionEvent — dispatch must not insert again.
    expect(insertActionEventSpy).toHaveBeenCalledTimes(1);

    // Dispatch ran and reached the (throwing) notify; the rejection is
    // swallowed by the per-plan catch and never surfaces to the route.
    await vi.waitFor(() => expect(notifySpy).toHaveBeenCalled());
  });
});
