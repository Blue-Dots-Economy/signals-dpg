import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * Plan B Task 10 — unit tests for GET /api/v1/aggregator/dashboard
 *
 * The new response shape is `{ by_domain: { [domain]: DomainBlock }, metadata }`.
 * Each DomainBlock has a per-item rollup with the extra per-user aggregates
 * (unique_users, complete_profiles_count, avg_profiles_per_user, etc.),
 * a paginated participants list, total_matching, and next_cursor.
 *
 * Strategy: vi.mock the drizzle `db` client + `@/services/metrics/staleness`.
 * The mock inspects each `db.select(projection).from(table).where(...)` chain
 * to decide which fixture to return. `db.execute` returns user-aggregate or
 * mode-wise-counts fixtures based on a counter (user_agg first, mode_rows
 * second per build_domain_block invocation).
 */

const state = {
  staleness: {
    refreshed: false,
    last_computed_at: new Date('2026-06-01T00:00:00Z'),
  } as { refreshed: boolean; last_computed_at: Date | null },
  org_metadata: JSON.stringify({ domains: ['seeker'] }) as string | null,
  rollup_rows: [
    {
      profile_status: 'new',
      n: 2,
      apps_total: 0,
      pending: 0,
      shortlisted: 0,
      rejected: 0,
    },
    {
      profile_status: 'active',
      n: 5,
      apps_total: 7,
      pending: 4,
      shortlisted: 1,
      rejected: 2,
    },
    {
      profile_status: 'at_risk',
      n: 3,
      apps_total: 3,
      pending: 0,
      shortlisted: 0,
      rejected: 3,
    },
  ] as Array<Record<string, unknown>>,
  user_agg_rows: [
    {
      unique_users: 8,
      complete_profiles_count: 4,
      users_with_applications: 3,
      new_users_last_7_days: 1,
      total_applications: 10,
    },
  ] as Array<Record<string, unknown>>,
  mode_rows: [
    { via: 'bulk', n: 6 },
    { via: 'self', n: 4 },
  ] as Array<Record<string, unknown>>,
  total_matching: 10,
  list_rows: [] as Array<Record<string, unknown>>,
  staleness_calls: [] as Array<{ org_id: string; domain: string }>,
  execute_call_counter: 0,
};

vi.mock('@/services/metrics/staleness', () => ({
  check_and_refresh_if_stale: vi.fn(
    async (aggregator_id: string, domain: string) => {
      state.staleness_calls.push({ org_id: aggregator_id, domain });
      return state.staleness;
    },
  ),
  TTL_SECONDS: 3600,
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const makeChain = (resolve: () => Promise<unknown>) => {
    const thenable = {
      then: (cb: (v: unknown) => unknown) => resolve().then(cb),
    };
    const limitOffsetChain = {
      offset: vi.fn(() => resolve()),
    };
    const orderByChain = {
      limit: vi.fn(() => limitOffsetChain),
    };
    const whereChain = {
      groupBy: vi.fn(() => thenable),
      orderBy: vi.fn(() => orderByChain),
      limit: vi.fn(() => resolve()),
      then: (cb: (v: unknown) => unknown) => resolve().then(cb),
    };
    return {
      from: vi.fn(() => ({
        where: vi.fn(() => whereChain),
      })),
    };
  };

  return {
    db: {
      select: vi.fn((projection?: Record<string, unknown>) => {
        const keys = Object.keys(projection ?? {});
        let mode: 'org' | 'rollup' | 'count' | 'list';
        if (keys.length === 1 && keys[0] === 'metadata') mode = 'org';
        else if (keys.includes('profile_status') && keys.includes('apps_total'))
          mode = 'rollup';
        else if (keys.length === 1 && keys[0] === 'n') mode = 'count';
        else mode = 'list';

        return makeChain(async () => {
          if (mode === 'org') return [{ metadata: state.org_metadata }];
          if (mode === 'rollup') return state.rollup_rows;
          if (mode === 'count') return [{ n: state.total_matching }];
          return state.list_rows;
        });
      }),
      execute: vi.fn(async () => {
        // build_domain_block calls db.execute twice per invocation:
        //   1st: user-aggregate query
        //   2nd: mode-wise-counts query
        const n = state.execute_call_counter++;
        const isUserAgg = n % 2 === 0;
        return isUserAgg ? state.user_agg_rows : state.mode_rows;
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
  ownerUserId: 'usr_1',
  itemType: 'profile_1.0',
  itemDomain: 'seeker',
  onboardedByOrgId: 'org_bbmp',
  onboardedVia: 'bulk',
  profileStatus: 'active',
  profileCompletionPct: 75,
  profileCreatedAt: new Date('2026-05-01T00:00:00Z'),
  profileLastUpdatedAt: new Date('2026-05-20T00:00:00Z'),
  ageDays: 31,
  applicationsTotal: 2,
  applicationsPending: 1,
  applicationsShortlisted: 0,
  applicationsRejected: 1,
  lastAppliedAt: new Date('2026-05-18T00:00:00Z'),
  lastShortlistedAt: null,
  lastRejectedAt: new Date('2026-05-19T00:00:00Z'),
  openings: null,
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
  state.rollup_rows = [
    {
      profile_status: 'new',
      n: 2,
      apps_total: 0,
      pending: 0,
      shortlisted: 0,
      rejected: 0,
    },
    {
      profile_status: 'active',
      n: 5,
      apps_total: 7,
      pending: 4,
      shortlisted: 1,
      rejected: 2,
    },
    {
      profile_status: 'at_risk',
      n: 3,
      apps_total: 3,
      pending: 0,
      shortlisted: 0,
      rejected: 3,
    },
  ];
  state.user_agg_rows = [
    {
      unique_users: 8,
      complete_profiles_count: 4,
      users_with_applications: 3,
      new_users_last_7_days: 1,
      total_applications: 10,
    },
  ];
  state.mode_rows = [
    { via: 'bulk', n: 6 },
    { via: 'self', n: 4 },
  ];
  state.total_matching = 10;
  state.list_rows = [
    sample_list_row(),
    sample_list_row({ itemId: 'itm_2', userId: 'usr_2', profileStatus: 'new' }),
  ];
  state.staleness_calls = [];
  state.execute_call_counter = 0;
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
    expect(body.by_domain.seeker.rollup.items_total).toBe(10);
    expect(body.by_domain.seeker.rollup.by_status).toEqual({
      new: 2,
      active: 5,
      at_risk: 3,
    });
  });

  it('200 rollup includes per-user aggregates + mode_wise_counts', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    const r = res.json().by_domain.seeker.rollup;
    expect(r.applications_total).toBe(10);
    expect(r.applications_pending).toBe(4);
    expect(r.applications_shortlisted).toBe(1);
    expect(r.applications_rejected).toBe(5);
    expect(r.unique_users).toBe(8);
    expect(r.complete_profiles_count).toBe(4);
    expect(r.users_with_applications).toBe(3);
    expect(r.new_users_last_7_days).toBe(1);
    // items_total / unique_users = 10 / 8 = 1.25
    expect(r.avg_profiles_per_user).toBeCloseTo(1.25);
    // total_applications / users_with_applications = 10 / 3
    expect(r.avg_applications_per_user).toBeCloseTo(10 / 3);
    expect(r.mode_wise_counts).toEqual({ bulk: 6, self: 4 });
  });

  it('200 participants have snake_case keys + ISO timestamps', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    const block = res.json().by_domain.seeker;
    expect(block.participants).toHaveLength(2);
    const p = block.participants[0];
    expect(p.item_id).toBe('itm_1');
    expect(p.owner_user_id).toBe('usr_1');
    expect(p.item_type).toBe('profile_1.0');
    expect(p.profile_status).toBe('active');
    expect(p.profile_completion_pct).toBe(75);
    expect(p.profile_created_at).toBe('2026-05-01T00:00:00.000Z');
    expect(p.profile_last_updated_at).toBe('2026-05-20T00:00:00.000Z');
    expect(p.applications_total).toBe(2);
    expect(p.applications_shortlisted).toBe(0);
    expect(p.actionable_tags).toEqual(['no_recent_activity']);
    expect(p.last_applied_at).toBe('2026-05-18T00:00:00.000Z');
    expect(p.last_shortlisted_at).toBeNull();
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
    expect(block.participants).toHaveLength(1);
    expect(block.participants[0].profile_status).toBe('active');
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
    state.rollup_rows = [];
    state.user_agg_rows = [
      {
        unique_users: 0,
        complete_profiles_count: 0,
        users_with_applications: 0,
        new_users_last_7_days: 0,
        total_applications: 0,
      },
    ];
    state.mode_rows = [];
    state.total_matching = 0;
    state.list_rows = [];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.metadata.last_computed_at).toBeNull();
    expect(body.by_domain.seeker.rollup.items_total).toBe(0);
    expect(body.by_domain.seeker.rollup.unique_users).toBe(0);
    expect(body.by_domain.seeker.rollup.avg_profiles_per_user).toBe(0);
    expect(body.by_domain.seeker.rollup.avg_applications_per_user).toBe(0);
    expect(body.by_domain.seeker.participants).toEqual([]);
  });

  it('passes acting_org.org_id + domain to check_and_refresh_if_stale', async () => {
    const app = await buildApp({
      org_id: 'org_xyz_ngo',
      org_type: 'aggregator',
    });
    await app.inject({ method: 'GET', url: '/dashboard' });
    expect(state.staleness_calls).toEqual([
      { org_id: 'org_xyz_ngo', domain: 'seeker' },
    ]);
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
