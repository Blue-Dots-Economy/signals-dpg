import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * Unit tests for GET /api/v1/aggregator/dashboard
 *
 * Response shape: `{ by_domain: { [domain]: DomainBlock }, metadata }`.
 * Each DomainBlock has a rollup (total_items, complete_profiles,
 * has_applications, by_status, by_action_status, avg_items_per_user,
 * avg_actions_per_user, mode_wise_counts), a paginated items list,
 * total_matching, and next_cursor.
 *
 * Strategy: vi.mock the drizzle `db` client + `@/services/metrics/staleness`.
 * build_domain_block calls db.execute twice per invocation:
 *   1st: single-row rollup aggregate
 *   2nd: mode-wise counts
 * db.select is used for the org metadata lookup, count query, and list rows.
 */

const state = {
  staleness: {
    refreshed: false,
    last_computed_at: new Date('2026-06-01T00:00:00Z'),
  } as { refreshed: boolean; last_computed_at: Date | null },
  org_metadata: JSON.stringify({ domains: ['seeker'] }) as string | null,
  // Single-row rollup fixture returned by the first db.execute call.
  rollup_row: {
    total_items: 10,
    complete_profiles: 4,
    has_applications: 3,
    s_new: 2,
    s_active: 5,
    s_at_risk: 3,
    s_inactive: 0,
    bi_create: 10,
    bi_accept: 1,
    bi_reject: 5,
    bi_cancel: 0,
    br_create: 0,
    br_accept: 4,
    br_reject: 1,
    br_cancel: 0,
    total_users: 8,
    total_actions: 21,
    engaged_users: 3,
  } as Record<string, number>,
  // Mode rows fixture returned by the second db.execute call.
  mode_rows: [
    { via: 'bulk', n: 6 },
    { via: 'self', n: 4 },
  ] as Array<Record<string, unknown>>,
  total_matching: 10,
  list_rows: [] as Array<Record<string, unknown>>,
  staleness_calls: [] as Array<{ org_id: string; domain: string; refresh: boolean }>,
  execute_call_counter: 0,
  // Private display-name resolution fixtures. network_cfg=null makes
  // getNetworkConfigById throw (the pre-existing tests' behaviour: the
  // resolver no-ops and the precomputed displayName passes through).
  network_cfg: null as Record<string, unknown> | null,
  item_rows: [] as Array<Record<string, unknown>>,
  items_throw: false,
  decrypt_throw: false,
  decrypt_merge: {} as Record<string, unknown>,
};

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: vi.fn(async () => {
    if (!state.network_cfg) throw new Error('network config not loaded');
    return state.network_cfg;
  }),
}));

vi.mock('@/utils/item_decrypt', () => ({
  decryptItemPrivate: vi.fn((row: { item_state: Record<string, unknown> }) => {
    if (state.decrypt_throw) throw new Error('bad blob');
    return { mergedState: { ...row.item_state, ...state.decrypt_merge } };
  }),
}));

vi.mock('@/services/metrics/staleness', () => ({
  check_and_refresh_if_stale: vi.fn(
    async (aggregator_id: string, domain: string, refresh: boolean) => {
      state.staleness_calls.push({ org_id: aggregator_id, domain, refresh: refresh ?? false });
      return state.staleness;
    },
  ),
  TTL_SECONDS: 3600,
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const makeChain = (resolve: () => Promise<unknown>) => {
    const limitOffsetChain = {
      offset: vi.fn(() => resolve()),
    };
    const orderByChain = {
      limit: vi.fn(() => limitOffsetChain),
    };
    const whereChain = {
      orderBy: vi.fn(() => orderByChain),
      limit: vi.fn(() => resolve()),
      // Forward BOTH handlers so a rejecting resolve() surfaces to `await`
      // as a rejection instead of hanging the thenable.
      then: (onOk: (v: unknown) => unknown, onErr?: (e: unknown) => unknown) =>
        resolve().then(onOk, onErr),
    };
    const fromChain: Record<string, unknown> = {
      where: vi.fn(() => whereChain),
    };
    return {
      from: vi.fn(() => fromChain),
    };
  };

  return {
    db: {
      select: vi.fn((projection?: Record<string, unknown>) => {
        const keys = Object.keys(projection ?? {});
        let mode: 'org' | 'count' | 'items' | 'list';
        if (keys.length === 1 && keys[0] === 'metadata') mode = 'org';
        else if (keys.length === 1 && keys[0] === 'n') mode = 'count';
        else if (keys.includes('item_private_state')) mode = 'items';
        else mode = 'list';

        return makeChain(async () => {
          if (mode === 'org') return [{ metadata: state.org_metadata }];
          if (mode === 'count') return [{ n: state.total_matching }];
          if (mode === 'items') {
            if (state.items_throw) throw new Error('connection terminated');
            return state.item_rows;
          }
          return state.list_rows;
        });
      }),
      execute: vi.fn(async () => {
        // build_domain_block calls db.execute twice per invocation:
        //   1st: rollup aggregate (single row)
        //   2nd: mode-wise counts
        const n = state.execute_call_counter++;
        const is_rollup = n % 2 === 0;
        return is_rollup ? [state.rollup_row] : state.mode_rows;
      }),
    },
  };
});

// Import the plugin AFTER mocks are set up.
import { aggregator_dashboard } from '../dashboard.js';

const buildApp = async (acting?: {
  org_id?: string;
  org_type?: 'aggregator' | 'voice' | 'network_service';
}) => {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addHook('preHandler', async (req) => {
    (req as unknown as { acting_org: unknown }).acting_org = {
      org_id: acting?.org_id ?? 'org_bbmp',
      org_type: acting?.org_type ?? 'aggregator',
      service_user_id: 'svc_aggregator_dpg',
    };
  });
  await app.register(aggregator_dashboard);
  return app;
};

const sample_list_row = (overrides: Record<string, unknown> = {}) => ({
  itemId: 'itm_1',
  itemNetwork: 'blue_dot',
  ownerUserId: 'usr_1',
  displayName: 'Test User',
  itemType: 'profile_1.0',
  itemDomain: 'seeker',
  onboardedByOrgId: 'org_bbmp',
  onboardedVia: 'bulk',
  profileStatus: 'active',
  profileCompletionPct: 75,
  profileCreatedAt: new Date('2026-05-01T00:00:00Z'),
  profileLastUpdatedAt: new Date('2026-05-20T00:00:00Z'),
  ageDays: 31,
  initiated: { create: 2, accept: 0, reject: 1, cancel: 0 },
  received: { create: 0, accept: 1, reject: 0, cancel: 0 },
  lastInitiatedAt: {
    create: '2026-05-18T00:00:00.000Z',
    reject: '2026-05-19T00:00:00.000Z',
  },
  lastReceivedAt: { accept: '2026-05-20T00:00:00.000Z' },
  actionableTags: ['no_recent_activity'],
  lastComputedAt: new Date('2026-06-01T00:00:00Z'),
  ...overrides,
});

const resetState = () => {
  state.staleness = {
    refreshed: false,
    last_computed_at: new Date('2026-06-01T00:00:00Z'),
  };
  state.org_metadata = JSON.stringify({ domains: ['seeker'] });
  state.rollup_row = {
    total_items: 10,
    complete_profiles: 4,
    has_applications: 3,
    s_new: 2,
    s_active: 5,
    s_at_risk: 3,
    s_inactive: 0,
    bi_create: 10,
    bi_accept: 1,
    bi_reject: 5,
    bi_cancel: 0,
    br_create: 0,
    br_accept: 4,
    br_reject: 1,
    br_cancel: 0,
    total_users: 8,
    total_actions: 21,
    engaged_users: 3,
  };
  state.mode_rows = [
    { via: 'bulk', n: 6 },
    { via: 'self', n: 4 },
  ];
  state.total_matching = 10;
  state.list_rows = [
    sample_list_row(),
    sample_list_row({ itemId: 'itm_2', ownerUserId: 'usr_2', profileStatus: 'new' }),
  ];
  state.staleness_calls = [];
  state.execute_call_counter = 0;
  state.network_cfg = null;
  state.item_rows = [];
  state.items_throw = false;
  state.decrypt_throw = false;
  state.decrypt_merge = {};
};

describe('GET /aggregator/dashboard', () => {
  beforeEach(() => {
    resetState();
  });

  it('403 NOT_AGGREGATOR when caller acts as network_service', async () => {
    const app = await buildApp({ org_type: 'network_service' });
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_AGGREGATOR');
    expect(state.staleness_calls.length).toBe(0);
  });

  it('403 NOT_AGGREGATOR when caller acts as voice', async () => {
    const app = await buildApp({ org_type: 'voice' });
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_AGGREGATOR');
  });

  it('400 NO_DOMAINS_CONFIGURED when org.metadata is null', async () => {
    state.org_metadata = null;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_DOMAINS_CONFIGURED');
    expect(state.staleness_calls.length).toBe(0);
  });

  it('400 NO_DOMAINS_CONFIGURED when domains array is empty', async () => {
    state.org_metadata = JSON.stringify({ domains: [] });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_DOMAINS_CONFIGURED');
  });

  it('400 NO_DOMAINS_CONFIGURED when metadata is unparseable JSON', async () => {
    state.org_metadata = 'not-json{{{';
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_DOMAINS_CONFIGURED');
  });

  it('400 DOMAIN_NOT_CONFIGURED when ?domain= is not in configured set', async () => {
    state.org_metadata = JSON.stringify({ domains: ['seeker'] });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?domain=provider',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('DOMAIN_NOT_CONFIGURED');
    expect(state.staleness_calls.length).toBe(0);
  });

  it('200 single-domain: by_domain has the one configured key', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.by_domain)).toEqual(['seeker']);
    expect(body.by_domain.seeker.rollup.total_items).toBe(10);
    expect(body.by_domain.seeker.rollup.by_status).toEqual({
      new: 2,
      active: 5,
      at_risk: 3,
      inactive: 0,
    });
  });

  it('200 rollup includes directional + user-level counts + avg fields + mode_wise_counts', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    const r = res.json().by_domain.seeker.rollup;
    expect(r.total_items).toBe(10);
    expect(r.complete_profiles).toBe(4);
    expect(r.has_applications).toBe(3);
    expect(r.by_initiated_action_status).toEqual({
      create: 10,
      accept: 1,
      reject: 5,
      cancel: 0,
    });
    expect(r.by_received_action_status).toEqual({
      create: 0,
      accept: 4,
      reject: 1,
      cancel: 0,
    });
    expect(r.total_users).toBe(8);
    // avg_items_per_user = total_items / total_users = 10 / 8 = 1.25
    expect(r.avg_items_per_user).toBeCloseTo(1.25);
    // avg_actions_per_user = total_actions / engaged_users = 21 / 3 = 7
    expect(r.avg_actions_per_user).toBeCloseTo(21 / 3);
    expect(r.mode_wise_counts).toEqual({ bulk: 6, self: 4 });
    // Confirm the old blended bucket is gone
    expect(r.by_action_status).toBeUndefined();
  });

  it('200 items have snake_case keys + ISO timestamps + directional maps', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    const block = res.json().by_domain.seeker;
    expect(block.items).toHaveLength(2);
    const p = block.items[0];
    expect(p.profile_item_id).toBe('itm_1');
    expect(p.user_id).toBe('usr_1');
    expect(p.item_network).toBe('blue_dot');
    expect(p.name).toBe('Test User');
    expect(p.item_type).toBe('profile_1.0');
    expect(p.profile_status).toBe('active');
    expect(p.profile_completion_pct).toBe(75);
    expect(p.profile_created_at).toBe('2026-05-01T00:00:00.000Z');
    expect(p.profile_last_updated_at).toBe('2026-05-20T00:00:00.000Z');
    expect(p.initiated).toEqual({ create: 2, accept: 0, reject: 1, cancel: 0 });
    expect(p.received).toEqual({ create: 0, accept: 1, reject: 0, cancel: 0 });
    // last_*_at maps are sparse — only buckets that occurred are present
    expect(p.last_initiated_at).toEqual({
      create: '2026-05-18T00:00:00.000Z',
      reject: '2026-05-19T00:00:00.000Z',
    });
    expect(p.last_received_at).toEqual({ accept: '2026-05-20T00:00:00.000Z' });
    expect(p.actionable_tags).toEqual(['no_recent_activity']);
    // Confirm old field names are gone
    expect(p.count_create).toBeUndefined();
    expect(p.last_create_at).toBeUndefined();
    expect(p.item_id).toBeUndefined();
    expect(p.owner_user_id).toBeUndefined();
  });

  it('200 ?status=active filter passes through to total_matching/list', async () => {
    state.total_matching = 5;
    state.list_rows = [sample_list_row({ profileStatus: 'active' })];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?status=active',
    });
    expect(res.statusCode).toBe(200);
    const block = res.json().by_domain.seeker;
    expect(block.total_matching).toBe(5);
    expect(block.items).toHaveLength(1);
    expect(block.items[0].profile_status).toBe('active');
  });

  it('200 metadata exposes last_computed_at, ttl_seconds, refreshed=false', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    const m = res.json().metadata;
    expect(m.last_computed_at).toBe('2026-06-01T00:00:00.000Z');
    expect(m.ttl_seconds).toBe(3600);
    expect(m.refreshed).toBe(false);
  });

  it('200 metadata.refreshed=true when staleness recomputed', async () => {
    state.staleness = {
      refreshed: true,
      last_computed_at: new Date('2026-06-01T12:00:00Z'),
    };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.json().metadata.refreshed).toBe(true);
  });

  it('200 first-time aggregator (null last_computed_at) returns null + zeros', async () => {
    state.staleness = { refreshed: true, last_computed_at: null };
    state.rollup_row = {
      total_items: 0,
      complete_profiles: 0,
      has_applications: 0,
      s_new: 0,
      s_active: 0,
      s_at_risk: 0,
      s_inactive: 0,
      bi_create: 0,
      bi_accept: 0,
      bi_reject: 0,
      bi_cancel: 0,
      br_create: 0,
      br_accept: 0,
      br_reject: 0,
      br_cancel: 0,
      total_users: 0,
      total_actions: 0,
      engaged_users: 0,
    };
    state.mode_rows = [];
    state.total_matching = 0;
    state.list_rows = [];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metadata.last_computed_at).toBeNull();
    expect(body.by_domain.seeker.rollup.total_items).toBe(0);
    expect(body.by_domain.seeker.rollup.avg_items_per_user).toBe(0);
    expect(body.by_domain.seeker.rollup.avg_actions_per_user).toBe(0);
    expect(body.by_domain.seeker.items).toEqual([]);
  });

  it('passes acting_org.org_id + domain to check_and_refresh_if_stale', async () => {
    const app = await buildApp({
      org_id: 'org_xyz_ngo',
      org_type: 'aggregator',
    });
    await app.inject({ method: 'GET', url: '/dashboard' });
    expect(state.staleness_calls[0]).toMatchObject({
      org_id: 'org_xyz_ngo',
      domain: 'seeker',
    });
  });

  it('passes refresh=true to check_and_refresh_if_stale when ?refresh=true', async () => {
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/dashboard?refresh=true' });
    expect(state.staleness_calls[0]?.refresh).toBe(true);
  });

  it('next_cursor is next page when full page returned', async () => {
    state.list_rows = Array.from({ length: 50 }, (_, i) =>
      sample_list_row({ itemId: `itm_${i}` }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?page=1&limit=50',
    });
    expect(res.json().by_domain.seeker.next_cursor).toBe('2');
  });

  it('next_cursor is null when fewer rows than limit returned', async () => {
    state.list_rows = Array.from({ length: 3 }, (_, i) =>
      sample_list_row({ itemId: `itm_${i}` }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?page=1&limit=50',
    });
    expect(res.json().by_domain.seeker.next_cursor).toBeNull();
  });
});

describe('private display-name resolution (aggregator-dpg#406)', () => {
  beforeEach(() => {
    resetState();
    // Clear decryptItemPrivate call history so not-called assertions don't
    // see calls leaked from earlier tests.
    vi.clearAllMocks();
  });

  /** Network config where the seeker schema has NO display_name_field but
   *  the domain card declares title_field, and the field is private —
   *  the purple_dot seeker shape. */
  const seekerCardCfg = () => ({
    domains: [
      {
        id: 'seeker',
        card: { title_field: 'beneficiary_name' },
        item_schemas: {
          'profile_1.0': { properties: { beneficiary_name: { private: true } } },
        },
      },
    ],
  });

  it('resolves the seeker name via card.title_field from the decrypted private state', async () => {
    state.network_cfg = seekerCardCfg();
    state.list_rows = [sample_list_row({ displayName: 'itm_1' })];
    state.item_rows = [
      {
        item_id: 'itm_1',
        item_type: 'profile_1.0',
        item_state: { beneficiary_name: 'R***' },
        item_private_state: 'v1:blob',
      },
    ];
    state.decrypt_merge = { beneficiary_name: 'Ravi Kumar' };

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().by_domain.seeker.items[0].name).toBe('Ravi Kumar');
  });

  it('prefers the schema display_name_field over card.title_field when both exist', async () => {
    state.network_cfg = {
      domains: [
        {
          id: 'seeker',
          card: { title_field: 'beneficiary_name' },
          item_schemas: {
            'profile_1.0': {
              display_name_field: 'organisation_name',
              properties: {
                organisation_name: { private: true },
                beneficiary_name: { private: true },
              },
            },
          },
        },
      ],
    };
    state.list_rows = [sample_list_row({ displayName: 'itm_1' })];
    state.item_rows = [
      {
        item_id: 'itm_1',
        item_type: 'profile_1.0',
        item_state: { organisation_name: 'S***' },
        item_private_state: 'v1:blob',
      },
    ];
    state.decrypt_merge = { organisation_name: 'Sahaya Trust' };

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.json().by_domain.seeker.items[0].name).toBe('Sahaya Trust');
  });

  it('skips decryption entirely when the display field is public (provider shape)', async () => {
    const { decryptItemPrivate } = await import('@/utils/item_decrypt');
    state.network_cfg = {
      domains: [
        {
          id: 'seeker',
          item_schemas: {
            // organisation_name is public — the precomputed metrics name is
            // already correct, so the resolver must not fetch or decrypt.
            'profile_1.0': {
              display_name_field: 'organisation_name',
              properties: { organisation_name: {} },
            },
          },
        },
      ],
    };
    state.list_rows = [sample_list_row({ displayName: 'Sahaya Trust' })];

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().by_domain.seeker.items[0].name).toBe('Sahaya Trust');
    expect(vi.mocked(decryptItemPrivate)).not.toHaveBeenCalled();
  });

  it('falls back to the precomputed display name when decryption fails', async () => {
    state.network_cfg = seekerCardCfg();
    state.list_rows = [sample_list_row({ displayName: 'itm_1' })];
    state.item_rows = [
      {
        item_id: 'itm_1',
        item_type: 'profile_1.0',
        item_state: { beneficiary_name: 'R***' },
        item_private_state: 'v1:corrupt',
      },
    ];
    state.decrypt_throw = true;

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().by_domain.seeker.items[0].name).toBe('itm_1');
  });

  it('falls back to the precomputed display name when the row has no private blob', async () => {
    state.network_cfg = seekerCardCfg();
    state.list_rows = [sample_list_row({ displayName: 'itm_1' })];
    state.item_rows = [
      {
        item_id: 'itm_1',
        item_type: 'profile_1.0',
        // Empty blob: merged state would surface the masked public value
        // ("R***") — the resolver must keep the precomputed name instead.
        item_state: { beneficiary_name: 'R***' },
        item_private_state: '',
      },
    ];

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().by_domain.seeker.items[0].name).toBe('itm_1');
  });

  it('still returns 200 with precomputed names when the items lookup fails', async () => {
    state.network_cfg = seekerCardCfg();
    state.list_rows = [sample_list_row({ displayName: 'itm_1' })];
    state.items_throw = true;

    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().by_domain.seeker.items[0].name).toBe('itm_1');
  });
});
