import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * Plan 3 Task 8 — failing tests for GET /api/v1/aggregator/dashboard.
 *
 * Strategy: vi.mock the drizzle `db` client AND `@/services/metrics/staleness`
 * so the route can be exercised without a real DB. The mock chain is
 * heuristic — it inspects the projection passed to `db.select(...)` to decide
 * which fixture to return (rollup vs count vs list).
 */

// State the tests control.
const state = {
  staleness: {
    refreshed: false,
    last_computed_at: new Date('2026-06-01T00:00:00Z'),
  } as { refreshed: boolean; last_computed_at: Date | null },
  rollup_rows: [
    { status: 'new', n: 2, pending: 0, accepted: 0, rejected: 0 },
    { status: 'active', n: 5, pending: 4, accepted: 1, rejected: 2 },
    { status: 'at_risk', n: 3, pending: 0, accepted: 0, rejected: 3 },
  ] as Array<Record<string, unknown>>,
  total_matching: 10,
  list_rows: [] as Array<Record<string, unknown>>,
  staleness_calls: 0,
  staleness_last_arg: '' as string,
};

vi.mock('@/services/metrics/staleness', () => ({
  check_and_refresh_if_stale: vi.fn(async (aggregator_id: string) => {
    state.staleness_calls++;
    state.staleness_last_arg = aggregator_id;
    return state.staleness;
  }),
  TTL_SECONDS: 3600,
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  // Each query chain is fully chainable; the terminal Promise resolves to
  // the appropriate test fixture. We choose a `mode` based on the
  // projection-shape passed to select().
  const makeChain = (resolve: () => Promise<unknown>) => {
    const thenable = {
      then: (cb: (v: unknown) => unknown) => resolve().then(cb),
    };
    const orderByChain = {
      limit: vi.fn(() => ({
        offset: vi.fn(() => resolve()),
      })),
    };
    const whereChain = {
      groupBy: vi.fn(() => thenable),
      orderBy: vi.fn(() => orderByChain),
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
        let mode: 'rollup' | 'count' | 'list';
        if (keys.includes('status') && keys.includes('n')) mode = 'rollup';
        else if (keys.length === 1 && keys[0] === 'n') mode = 'count';
        else mode = 'list';

        return makeChain(async () => {
          if (mode === 'rollup') return state.rollup_rows;
          if (mode === 'count') return [{ n: state.total_matching }];
          return state.list_rows;
        });
      }),
    },
  };
});

// Import the plugin AFTER mocks. This import FAILS until Task 9 lands.
import { aggregator_dashboard } from '../dashboard.js';

const buildApp = async (
  acting?: {
    org_id?: string;
    org_type?: 'aggregator' | 'voice' | 'network_service';
  },
) => {
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
  userId: 'usr_1',
  onboardedByOrgId: 'org_bbmp',
  onboardedVia: 'bulk',
  profileStatus: 'active',
  profileCompletionPct: 75,
  profileCreatedAt: new Date('2026-05-01T00:00:00Z'),
  profileLastUpdatedAt: new Date('2026-05-20T00:00:00Z'),
  ageDays: 31,
  applicationsPending: 1,
  applicationsAccepted: 0,
  applicationsRejected: 1,
  applicationsTotal: 2,
  actionableTags: ['no_recent_activity'],
  lastComputedAt: new Date('2026-06-01T00:00:00Z'),
  ...overrides,
});

describe('GET /aggregator/dashboard', () => {
  beforeEach(() => {
    state.staleness = {
      refreshed: false,
      last_computed_at: new Date('2026-06-01T00:00:00Z'),
    };
    state.rollup_rows = [
      { status: 'new', n: 2, pending: 0, accepted: 0, rejected: 0 },
      { status: 'active', n: 5, pending: 4, accepted: 1, rejected: 2 },
      { status: 'at_risk', n: 3, pending: 0, accepted: 0, rejected: 3 },
    ];
    state.total_matching = 10;
    state.list_rows = [
      sample_list_row(),
      sample_list_row({ userId: 'usr_2', profileStatus: 'new' }),
    ];
    state.staleness_calls = 0;
    state.staleness_last_arg = '';
  });

  it('403 NOT_AGGREGATOR when caller acts as network_service', async () => {
    const app = await buildApp({ org_type: 'network_service' });
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_AGGREGATOR');
    expect(state.staleness_calls).toBe(0);
  });

  it('403 NOT_AGGREGATOR when caller acts as voice', async () => {
    const app = await buildApp({ org_type: 'voice' });
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(403);
  });

  it('200 returns rollup with totals computed across status rows', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.rollup.participants_total).toBe(10);
    expect(body.rollup.by_status).toEqual({ new: 2, active: 5, at_risk: 3 });
    expect(body.rollup.applications_pending).toBe(4);
    expect(body.rollup.applications_accepted).toBe(1);
    expect(body.rollup.applications_rejected).toBe(5);
  });

  it('200 returns participants with snake_case keys + ISO timestamps', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    const body = res.json();
    expect(body.participants).toHaveLength(2);
    const first = body.participants[0];
    expect(first.user_id).toBe('usr_1');
    expect(first.profile_status).toBe('active');
    expect(first.profile_completion_pct).toBe(75);
    expect(first.profile_created_at).toBe('2026-05-01T00:00:00.000Z');
    expect(first.profile_last_updated_at).toBe('2026-05-20T00:00:00.000Z');
    expect(first.actionable_tags).toEqual(['no_recent_activity']);
  });

  it('200 exposes metadata with last_computed_at, ttl_seconds, refreshed=false', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    const body = res.json();
    expect(body.metadata.last_computed_at).toBe('2026-06-01T00:00:00.000Z');
    expect(body.metadata.ttl_seconds).toBe(3600);
    expect(body.metadata.refreshed).toBe(false);
  });

  it('200 metadata.refreshed=true when staleness path recomputed', async () => {
    state.staleness = {
      refreshed: true,
      last_computed_at: new Date('2026-06-01T12:00:00Z'),
    };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.json().metadata.refreshed).toBe(true);
  });

  it('200 handles first-time aggregator (null last_computed_at) without throwing', async () => {
    state.staleness = { refreshed: true, last_computed_at: null };
    state.list_rows = [];
    state.rollup_rows = [];
    state.total_matching = 0;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json().metadata.last_computed_at).toBeNull();
    expect(res.json().rollup.participants_total).toBe(0);
    expect(res.json().participants).toEqual([]);
  });

  it('200 total_matching reflects the count query', async () => {
    state.total_matching = 42;
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?page=1&limit=50',
    });
    expect(res.json().total_matching).toBe(42);
  });

  it('passes acting_org.org_id to check_and_refresh_if_stale', async () => {
    const app = await buildApp({ org_id: 'org_xyz_ngo', org_type: 'aggregator' });
    await app.inject({ method: 'GET', url: '/dashboard' });
    expect(state.staleness_calls).toBe(1);
    expect(state.staleness_last_arg).toBe('org_xyz_ngo');
  });

  it('next_cursor is the next page number string when full page returned', async () => {
    state.list_rows = Array.from({ length: 50 }, (_, i) =>
      sample_list_row({ userId: `usr_${i}` }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?page=1&limit=50',
    });
    expect(res.json().next_cursor).toBe('2');
  });

  it('next_cursor is null when fewer rows than limit returned', async () => {
    state.list_rows = Array.from({ length: 3 }, (_, i) =>
      sample_list_row({ userId: `usr_${i}` }),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?page=1&limit=50',
    });
    expect(res.json().next_cursor).toBeNull();
  });
});
