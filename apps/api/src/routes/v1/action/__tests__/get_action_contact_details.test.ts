import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

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

type ActionRow = {
  action_id: string;
  action_type: string;
  action_status: string;
  source_item_owner: string | null;
  target_item_owner: string | null;
  source_item_network: string;
  source_item_domain: string;
  source_item_type: string;
  source_item_id: string;
  source_item_instance_url: string;
  target_item_network: string;
  target_item_domain: string;
  target_item_type: string;
  target_item_id: string;
  target_item_instance_url: string;
};

const state = {
  action: null as ActionRow | null,
  fetchedItems: [] as Array<Record<string, unknown>>,
  auditInsertShouldThrow: false,
  auditInserts: [] as Array<Record<string, unknown>>,
  callerSnapshotLifecycle: 'live' as string | null,
};

const auditInsertMock = vi.fn(async (row: Record<string, unknown>) => {
  if (state.auditInsertShouldThrow) throw new Error('audit insert failed');
  state.auditInserts.push(row);
});

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (state.action ? [state.action] : []),
        }),
      }),
    }),
    insert: () => ({
      values: async (row: Record<string, unknown>) => auditInsertMock(row),
    }),
  },
}));

vi.mock('@/utils/item_fetch_runtime', () => ({
  fetchLocalItems: vi.fn(async () => ({
    meta: { total: state.fetchedItems.length, limit: 1, offset: 0 },
    items: state.fetchedItems,
  })),
}));

vi.mock('@/utils/action_event_runtime', () => ({
  fetchLocalItemSnapshot: vi.fn(async () =>
    state.callerSnapshotLifecycle !== null
      ? { lifecycle_status: state.callerSnapshotLifecycle }
      : null
  ),
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => ({
    id: 'test_net',
    actions: {
      connect: {
        interactions: [
          {
            from_network: 'test_net',
            from_domain: 'seeker',
            from_items: [],
            to_network: 'test_net',
            to_domain: 'provider',
            to_items: [],
            requirement_schema: { type: 'object' },
            event_schema: {
              type: 'object',
              properties: {
                status: { type: 'string', enum: ['created', 'accepted', 'rejected'] },
              },
            },
            reveals_pii_on_status: ['accepted'],
          },
        ],
      },
    },
  })),
}));

const { get_action_contact_details } = await import(
  '../get_action_contact_details'
);

let app: FastifyInstance;

const SOURCE_OWNER = 'user_source';
const TARGET_OWNER = 'user_target';
const ACTION_ID = '11111111-1111-4111-8111-111111111111';
const SOURCE_ITEM_ID = '22222222-2222-4222-8222-222222222222';
const TARGET_ITEM_ID = '33333333-3333-4333-8333-333333333333';

function buildAction(overrides: Partial<ActionRow> = {}): ActionRow {
  return {
    action_id: ACTION_ID,
    action_type: 'connect',
    action_status: 'accepted',
    source_item_owner: SOURCE_OWNER,
    target_item_owner: TARGET_OWNER,
    source_item_network: 'test_net',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1.0',
    source_item_id: SOURCE_ITEM_ID,
    source_item_instance_url: 'http://source.local',
    target_item_network: 'test_net',
    target_item_domain: 'provider',
    target_item_type: 'profile_1.0',
    target_item_id: TARGET_ITEM_ID,
    target_item_instance_url: 'http://source.local',
    ...overrides,
  };
}

function buildItem(
  item_id: string,
  ownerId: string,
  overrides: Partial<Record<string, unknown>> = {}
) {
  return {
    item_network: 'test_net',
    item_domain: 'provider',
    item_type: 'profile_1.0',
    item_id,
    item_instance_url: 'http://source.local',
    item_schema_url: 'http://source.local/schema/profile_1.0.json',
    item_state: { name: 'Public Name', phone: '+15550001111' },
    item_locations: [],
    created_by: ownerId,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-02T00:00:00Z'),
    lifecycle_status: 'live',
    ...overrides,
  };
}

function buildApp(user: { id: string } | null) {
  const fastify = Fastify().withTypeProvider<ZodTypeProvider>();
  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  fastify.addHook('preHandler', async (req) => {
    if (user) (req as any).user = user;
  });
  fastify.register(get_action_contact_details);
  return fastify;
}

beforeEach(() => {
  state.action = null;
  state.fetchedItems = [];
  state.auditInsertShouldThrow = false;
  state.auditInserts = [];
  state.callerSnapshotLifecycle = 'live';
  auditInsertMock.mockClear();
});

describe('GET /:action_id/contact-details', () => {
  it('401 when no request.user', async () => {
    app = buildApp(null);
    state.action = buildAction();
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('UNAUTHORIZED');
  });

  it('404 ACTION_NOT_FOUND when no row matches', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = null;
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('ACTION_NOT_FOUND');
  });

  it('403 NOT_ACTION_PARTICIPANT when caller is neither owner', async () => {
    app = buildApp({ id: 'someone_else' });
    state.action = buildAction();
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_ACTION_PARTICIPANT');
  });

  it.each(['created', 'pending', 'rejected', 'cancelled'])(
    '403 PII_NOT_REVEALED when status is %s (live counterparty, non-reveal status)',
    async (status) => {
      app = buildApp({ id: SOURCE_OWNER });
      state.action = buildAction({ action_status: status });
      // Counterparty exists + is live — the endpoint resolves it first, then the
      // reveal-status gate returns PII_NOT_REVEALED (retired short-circuits earlier).
      state.fetchedItems = [buildItem(TARGET_ITEM_ID, TARGET_OWNER)];
      const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('PII_NOT_REVEALED');
    }
  );

  it('200 retired notice when the counterparty is retired (cancelled action)', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction({ action_status: 'cancelled' });
    state.fetchedItems = [buildItem(TARGET_ITEM_ID, TARGET_OWNER, { lifecycle_status: 'retired' })];
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revealed).toBe(false);
    expect(body.reveal_blocked_reason).toBe('retired');
    expect(body.other_actor.item.item_id).toBe(TARGET_ITEM_ID);
  });

  it('200 when source owner calls on accepted — returns target item merged', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction();
    state.fetchedItems = [buildItem(TARGET_ITEM_ID, TARGET_OWNER)];
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.action_id).toBe(ACTION_ID);
    expect(body.action_status).toBe('accepted');
    expect(body.revealed).toBe(true);
    expect(body.other_actor.item.item_id).toBe(TARGET_ITEM_ID);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('200 when target owner calls on accepted — returns source item', async () => {
    app = buildApp({ id: TARGET_OWNER });
    state.action = buildAction();
    state.fetchedItems = [buildItem(SOURCE_ITEM_ID, SOURCE_OWNER)];
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(200);
    expect(res.json().revealed).toBe(true);
    expect(res.json().other_actor.item.item_id).toBe(SOURCE_ITEM_ID);
  });

  it('501 CROSS_INSTANCE_REVEAL_NOT_SUPPORTED when other actor lives elsewhere', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction({
      target_item_instance_url: 'http://elsewhere.local',
    });
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('CROSS_INSTANCE_REVEAL_NOT_SUPPORTED');
  });

  it('404 OTHER_ITEM_NOT_FOUND when local item lookup misses', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction();
    state.fetchedItems = [];
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('OTHER_ITEM_NOT_FOUND');
  });

  it('200 revealed:false (masked) when other actor profile is not live (#273)', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction();
    state.fetchedItems = [buildItem(TARGET_ITEM_ID, TARGET_OWNER, { lifecycle_status: 'draft' })];
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revealed).toBe(false);
    expect(body.reveal_blocked_reason).toBe('other');
    expect(body.other_actor.item.item_id).toBe(TARGET_ITEM_ID);
    // Masked view is not a reveal → no audit row.
    expect(auditInsertMock).not.toHaveBeenCalled();
  });

  it('200 revealed:false (masked) when caller own profile is not live (#273)', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction();
    state.callerSnapshotLifecycle = 'draft';
    // other actor item is live — PII must still be withheld due to caller's own status
    state.fetchedItems = [buildItem(TARGET_ITEM_ID, TARGET_OWNER)];
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.revealed).toBe(false);
    expect(body.reveal_blocked_reason).toBe('self');
    expect(body.other_actor.item.item_id).toBe(TARGET_ITEM_ID);
    expect(auditInsertMock).not.toHaveBeenCalled();
  });

  it('writes one audit row on a revealed 2xx', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction();
    state.fetchedItems = [buildItem(TARGET_ITEM_ID, TARGET_OWNER)];
    await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(auditInsertMock).toHaveBeenCalledTimes(1);
    expect(state.auditInserts[0]).toMatchObject({
      actionId: ACTION_ID,
      viewerUserId: SOURCE_OWNER,
      revealedItemId: TARGET_ITEM_ID,
      revealedItemOwner: TARGET_OWNER,
      revealedActionType: 'connect',
      revealedActionStatusAtView: 'accepted',
    });
  });

  it('audit insert failure does not block the 200', async () => {
    app = buildApp({ id: SOURCE_OWNER });
    state.action = buildAction();
    state.fetchedItems = [buildItem(TARGET_ITEM_ID, TARGET_OWNER)];
    state.auditInsertShouldThrow = true;
    const res = await app.inject({ method: 'GET', url: `/${ACTION_ID}/contact-details` });
    expect(res.statusCode).toBe(200);
  });
});
