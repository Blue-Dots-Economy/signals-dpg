import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';

/**
 * Plan C Task 3 — failing tests for POST /api/v1/admin/participant.
 *
 * Mounts the tier-aware upsert route in isolation (no auth_middleware,
 * no acting_org preHandler), stubs request.acting_org via a preHandler
 * hook, and asserts the dispatch matrix from resolve_upsert_action +
 * the runtime ownership check produces the right response shape and
 * the right side effects on the mocked DB / item helpers.
 */

// --- mock @/config so loadEnv() never runs ---
vi.mock('@/config', () => ({
  apiConfig: {
    domain: 'http://source.local',
    port: 3000,
    served_domains: [
      { network: 'blue_dot', domain: 'seeker' },
      { network: 'blue_dot', domain: 'provider' },
    ],
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

// --- neutralize the auth chain ---
vi.mock('@/routes/auth/create_auth', () => {
  return {
    authInstance: {
      api: {
        signUpEmail: vi.fn(async () => {
          if (dbState.signUpMode === 'unique_violation') {
            const err: Error & { code?: string } = new Error(
              'duplicate key value violates unique constraint',
            );
            err.code = '23505';
            throw err;
          }
          return { user: { id: dbState.signUpUserId } };
        }),
      },
    },
  };
});

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: vi.fn(async () => {}),
  auth_middleware: vi.fn(async () => {}),
}));

// --- mock @dpg/database: keep real exports for schemas/items, stub ensureItemPartition ---
vi.mock('@dpg/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dpg/database')>();
  return {
    ...actual,
    ensureItemPartition: vi.fn(async () => {}),
  };
});

// --- mock @dpg/schemas: keep real exports + neutralize the merge helper for tests ---
vi.mock('@dpg/schemas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dpg/schemas')>();
  return {
    ...actual,
    mergeItemStateWithPrivate: (pub: Record<string, unknown>) => pub,
  };
});

// --- shared mock state ---
type ItemRow = {
  item_id: string;
  item_network: string;
  item_domain: string;
  item_type: string;
  item_state: Record<string, unknown>;
  item_private_state: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
};

const dbState: {
  existingUserRows: Array<{
    id: string;
    email: string | null;
    phoneNumber: string | null;
    onboardedByOrgId: string | null;
  }>;
  itemsByUser: Map<string, ItemRow[]>;
  itemOwnerLookup: Map<string, string>; // item_id -> user_id
  updates: Array<{ id: string; set: Record<string, unknown> }>;
  inserts: Array<{ user_id: string; network: string; domain: string; item_type: string }>;
  signUpMode: 'ok' | 'unique_violation';
  signUpUserId: string;
} = {
  existingUserRows: [],
  itemsByUser: new Map(),
  itemOwnerLookup: new Map(),
  updates: [],
  inserts: [],
  signUpMode: 'ok',
  signUpUserId: 'usr_new_default',
};

// Discriminate db.select() projections by their key set, so the same
// db mock can serve user-lookups, ownership-lookups, and items-list reads.
type SelectMode = 'user' | 'items_list' | 'item_owner' | 'unknown';

const classifyProjection = (proj: Record<string, unknown>): SelectMode => {
  const keys = Object.keys(proj);
  if (keys.includes('onboardedByOrgId')) return 'user';
  if (keys.length === 1 && keys[0] === 'created_by') return 'item_owner';
  if (keys.includes('item_state') && keys.includes('item_private_state')) {
    return 'items_list';
  }
  return 'unknown';
};

// Last user_id captured from a select-where call so items_list reads can
// scope their results. We use the most-recent user_id queried; tests are
// single-flow so there's no contention.
let lastQueriedUserId: string | null = null;
// Last item_id captured from an item-owner lookup.
let lastQueriedItemId: string | null = null;

// Intercept eq()/and()/inArray() drizzle expressions: drizzle returns
// opaque SQL builders, so we can't introspect them directly. Instead the
// test's user_id is fed via a side channel — the existingUserRows[0].id —
// since each test only ever has one user in scope.
vi.mock('@api/db/postgres/drizzle_config', () => {
  const makeSelectChain = (proj: Record<string, unknown>) => {
    const mode = classifyProjection(proj);
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(() => {
            if (mode === 'user') {
              return Promise.resolve(dbState.existingUserRows);
            }
            if (mode === 'item_owner') {
              const item_id = lastQueriedItemId;
              const owner = item_id
                ? dbState.itemOwnerLookup.get(item_id)
                : undefined;
              if (!owner) return Promise.resolve([]);
              return Promise.resolve([{ created_by: owner }]);
            }
            return Promise.resolve([]);
          }),
          orderBy: vi.fn(() => {
            if (mode === 'items_list') {
              const user_id = lastQueriedUserId;
              const rows = user_id
                ? dbState.itemsByUser.get(user_id) ?? []
                : [];
              // Scope by served-domain networks (only blue_dot in tests).
              const allowedNetworks = new Set(['blue_dot']);
              const filtered = rows.filter((r) =>
                allowedNetworks.has(r.item_network),
              );
              return Promise.resolve(filtered);
            }
            return Promise.resolve([]);
          }),
        })),
      })),
    };
  };

  const select = vi.fn((proj: Record<string, unknown>) =>
    makeSelectChain(proj),
  );

  const update = vi.fn(() => ({
    set: vi.fn((values: Record<string, unknown>) => ({
      where: vi.fn(() => {
        dbState.updates.push({
          id: dbState.signUpUserId,
          set: values,
        });
        return Promise.resolve();
      }),
    })),
  }));

  const deleteFn = vi.fn(() => ({
    where: vi.fn(() => Promise.resolve()),
  }));

  const transaction = vi.fn(
    async (cb: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        select,
        update,
        insert: vi.fn(),
      };
      return cb(tx);
    },
  );

  return {
    db: {
      select,
      update,
      transaction,
      delete: deleteFn,
    },
  };
});

// --- mock create_profile_item helper: simulates an item insert ---
vi.mock('@/lib/profile_item', () => {
  // Inline UUID generator so the factory is hoist-safe.
  let uuidCounter = 0;
  const fakeUuid = () => {
    uuidCounter += 1;
    const hex = uuidCounter.toString(16).padStart(8, '0');
    return `${hex}-1111-4111-8111-111111111111`;
  };
  return {
    create_profile_item: vi.fn(async (input: {
      user_id: string;
      network: string;
      domain: string;
      item_type: string;
      payload: Record<string, unknown>;
    }) => {
      const item_id = fakeUuid();
    const now = new Date();
    const row: ItemRow = {
      item_id,
      item_network: input.network,
      item_domain: input.domain,
      item_type: input.item_type,
      item_state: input.payload,
      item_private_state: {},
      created_at: now,
      updated_at: now,
    };
    const list = dbState.itemsByUser.get(input.user_id) ?? [];
    list.push(row);
    dbState.itemsByUser.set(input.user_id, list);
    dbState.itemOwnerLookup.set(item_id, input.user_id);
    dbState.inserts.push({
      user_id: input.user_id,
      network: input.network,
      domain: input.domain,
      item_type: input.item_type,
    });
    return { item_id };
  }),
  };
});

// --- mock item_service.updateItemInternal: simulates item update ---
vi.mock('@/services/item_service', () => {
  class ItemServiceError extends Error {
    statusCode: number;
    errorCode: string;
    constructor(statusCode: number, errorCode: string, message: string) {
      super(message);
      this.statusCode = statusCode;
      this.errorCode = errorCode;
    }
  }
  return {
    ItemServiceError,
    updateItemInternal: vi.fn(
      async (
        _tx: unknown,
        itemId: string,
        callerId: string,
        isAdmin: boolean,
        body: { item_state?: Record<string, unknown> },
      ) => {
        const owner = dbState.itemOwnerLookup.get(itemId);
        if (!owner || (!isAdmin && owner !== callerId)) {
          throw new ItemServiceError(
            404,
            'ITEM_NOT_FOUND_OR_FORBIDDEN',
            'Item not found or does not belong to the authenticated user',
          );
        }
        // Mutate the matched row in itemsByUser.
        const list = dbState.itemsByUser.get(owner) ?? [];
        const idx = list.findIndex((r) => r.item_id === itemId);
        if (idx >= 0 && body.item_state) {
          list[idx] = {
            ...list[idx],
            item_state: body.item_state,
            updated_at: new Date(),
          };
        }
        return list[idx];
      },
    ),
  };
});

// Imported after mocks.
import { participant } from '../participant.js';

const VALID_EMAIL = 'demo@example.com';
const VALID_PHONE = '+919876543210';

const baseBody = (over: Record<string, unknown> = {}) => ({
  email: VALID_EMAIL,
  name: 'Demo',
  terms_accepted: true,
  privacy_accepted: true,
  channel: 'bulk',
  item_state: { whoIAm: { education: 'XII' } },
  ...over,
});

const buildApp = async (
  acting?: {
    org_id?: string;
    org_type?: 'aggregator' | 'voice' | 'network_service';
  } | null,
): Promise<FastifyInstance> => {
  const app = Fastify().withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    if (acting !== null) {
      (req as unknown as { acting_org: unknown }).acting_org = {
        org_id: acting?.org_id ?? 'org_agg_1',
        org_type: acting?.org_type ?? 'aggregator',
        service_user_id: 'svc_test',
      };
    }
  });
  await app.register(participant);
  return app;
};

const VALID_UUID_A = '11111111-1111-4111-8111-111111111111';
const VALID_UUID_B = '22222222-2222-4222-8222-222222222222';

describe('POST /admin/participant', () => {
  beforeEach(() => {
    dbState.existingUserRows = [];
    dbState.itemsByUser = new Map();
    dbState.itemOwnerLookup = new Map();
    dbState.updates = [];
    dbState.inserts = [];
    dbState.signUpMode = 'ok';
    dbState.signUpUserId = 'usr_new_default';
    lastQueriedUserId = null;
    lastQueriedItemId = null;
  });

  it('403 INVALID_ACTING_ORG when acting_org is missing', async () => {
    const app = await buildApp(null);
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('INVALID_ACTING_ORG');
  });

  it('403 ACTING_ORG_TYPE_NOT_ALLOWED for voice', async () => {
    const app = await buildApp({ org_type: 'voice' });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ACTING_ORG_TYPE_NOT_ALLOWED');
  });

  it('aggregator + new user → 200 user_existed:false, items:[1], inserts:1', async () => {
    dbState.signUpUserId = 'usr_new_agg';
    lastQueriedUserId = 'usr_new_agg';
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.user_id).toBe('usr_new_agg');
    expect(body.onboarded_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.items).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('aggregator + existing OWN user → 200 user_existed:true, items populated, onboarded_at:null, no writes', async () => {
    const user_id = 'usr_own';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { foo: 'bar' },
        item_private_state: {},
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.user_id).toBe(user_id);
    expect(body.onboarded_at).toBeNull();
    expect(body.items).toHaveLength(1);
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('aggregator + existing OTHER-aggregator user → 200 items:[], no writes', async () => {
    const user_id = 'usr_other_agg';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_2',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { foo: 'bar' },
        item_private_state: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(true);
    expect(body.items).toEqual([]);
    expect(dbState.updates).toHaveLength(0);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('aggregator + existing self-registered user (onboardedByOrgId null) → 200 items:[]', async () => {
    const user_id = 'usr_self';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: null,
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        item_private_state: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([]);
  });

  it('network_service + new user → 200 user_existed:false, items:[1]', async () => {
    dbState.signUpUserId = 'usr_new_ns';
    lastQueriedUserId = 'usr_new_ns';
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ phone_number: VALID_PHONE, email: undefined }),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.user_existed).toBe(false);
    expect(body.user_id).toBe('usr_new_ns');
    expect(body.items).toHaveLength(1);
    expect(dbState.inserts).toHaveLength(1);
  });

  it('network_service + existing user + valid item_id → 200, item updated', async () => {
    const user_id = 'usr_ns_existing';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: {},
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_A;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_id: VALID_UUID_A,
        item_state: { v: 2 },
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(updateItemInternal)).toHaveBeenCalledTimes(1);
    expect(dbState.inserts).toHaveLength(0);
  });

  it('network_service + existing user + invalid item_id (other user) → 403 ITEM_NOT_OWNED_BY_USER', async () => {
    const user_id = 'usr_ns_existing';
    const other_user = 'usr_someone_else';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    // Item belongs to a DIFFERENT user.
    dbState.itemOwnerLookup.set(VALID_UUID_B, other_user);
    lastQueriedUserId = user_id;
    lastQueriedItemId = VALID_UUID_B;
    const { updateItemInternal } = await import('@/services/item_service');
    vi.mocked(updateItemInternal).mockClear();
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({
        item_id: VALID_UUID_B,
        item_state: { v: 2 },
      }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('ITEM_NOT_OWNED_BY_USER');
    expect(vi.mocked(updateItemInternal)).not.toHaveBeenCalled();
    expect(dbState.updates).toHaveLength(0);
  });

  it('network_service + existing user + no item_id → 200, inserts:1', async () => {
    const user_id = 'usr_ns_insert';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    dbState.itemsByUser.set(user_id, []);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.inserts).toHaveLength(1);
    const body = res.json();
    expect(body.items.length).toBeGreaterThanOrEqual(1);
  });

  it('network_service + existing user + duplicate (network,domain,item_type) + no item_id → 200, still inserts', async () => {
    const user_id = 'usr_ns_dup';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_ns_1',
      },
    ];
    // Pre-existing item of (blue_dot, seeker, profile_1.0).
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: { v: 1 },
        item_private_state: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    dbState.itemOwnerLookup.set(VALID_UUID_A, user_id);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_ns_1',
      org_type: 'network_service',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    expect(dbState.inserts).toHaveLength(1);
    // items grew by one.
    expect(dbState.itemsByUser.get(user_id)).toHaveLength(2);
  });

  it('400 when neither email nor phone_number is provided', async () => {
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody({ email: undefined }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('items response scoped to served-domain networks only', async () => {
    const user_id = 'usr_with_cross_network';
    dbState.existingUserRows = [
      {
        id: user_id,
        email: VALID_EMAIL,
        phoneNumber: null,
        onboardedByOrgId: 'org_agg_1',
      },
    ];
    // One item in served network, one in a foreign network.
    dbState.itemsByUser.set(user_id, [
      {
        item_id: VALID_UUID_A,
        item_network: 'blue_dot',
        item_domain: 'seeker',
        item_type: 'profile_1.0',
        item_state: {},
        item_private_state: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
      {
        item_id: VALID_UUID_B,
        item_network: 'yellow_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_state: {},
        item_private_state: {},
        created_at: new Date(),
        updated_at: new Date(),
      },
    ]);
    lastQueriedUserId = user_id;
    const app = await buildApp({
      org_id: 'org_agg_1',
      org_type: 'aggregator',
    });
    const res = await app.inject({
      method: 'POST',
      url: '/participant',
      payload: baseBody(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].item_network).toBe('blue_dot');
  });
});
