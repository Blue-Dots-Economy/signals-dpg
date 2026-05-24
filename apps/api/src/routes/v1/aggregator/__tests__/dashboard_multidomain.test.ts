import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * Plan B Task 10 — multi-domain unit tests for GET /api/v1/aggregator/dashboard.
 *
 * Covers the multi-domain shape: when org.metadata.domains has more than
 * one entry, by_domain contains one block per domain, staleness is checked
 * per domain (in parallel via Promise.all), and the top-level
 * last_computed_at is the earliest across the per-domain timestamps.
 *
 * Mock pattern mirrors dashboard.test.ts but the staleness mock can return
 * different timestamps per domain.
 */

interface StalenessOutcome {
  refreshed: boolean;
  last_computed_at: Date | null;
}

const state = {
  // Per-domain staleness outcome (keyed by domain string).
  staleness_by_domain: {} as Record<string, StalenessOutcome>,
  // Fallback if a domain isn't explicitly mapped.
  staleness_default: {
    refreshed: false,
    last_computed_at: new Date('2026-06-01T00:00:00Z'),
  } as StalenessOutcome,
  org_metadata: JSON.stringify({
    domains: ['seeker', 'provider'],
  }) as string | null,
  // Per-domain rollup fixtures.
  rollup_by_domain: {} as Record<string, Array<Record<string, unknown>>>,
  user_agg_by_domain: {} as Record<string, Array<Record<string, unknown>>>,
  mode_rows_by_domain: {} as Record<string, Array<Record<string, unknown>>>,
  total_matching_by_domain: {} as Record<string, number>,
  list_rows_by_domain: {} as Record<string, Array<Record<string, unknown>>>,
  staleness_calls: [] as Array<{ org_id: string; domain: string }>,
  // db.select cycles in domain order — we use a counter to attribute
  // each rollup/count/list call to the next domain in scope.
  select_cycle: {
    domain_order: [] as string[],
    rollup_idx: 0,
    count_idx: 0,
    list_idx: 0,
  },
  execute_cycle: {
    domain_order: [] as string[],
    counter: 0,
  },
};

vi.mock('@/services/metrics/staleness', () => ({
  check_and_refresh_if_stale: vi.fn(
    async (aggregator_id: string, domain: string) => {
      state.staleness_calls.push({ org_id: aggregator_id, domain });
      return state.staleness_by_domain[domain] ?? state.staleness_default;
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
    const fromChain: Record<string, unknown> = {
      where: vi.fn(() => whereChain),
    };
    fromChain.leftJoin = vi.fn(() => fromChain);
    return {
      from: vi.fn(() => fromChain),
    };
  };

  const nextDomain = (which: 'rollup' | 'count' | 'list'): string => {
    const order = state.select_cycle.domain_order;
    const key = `${which}_idx` as const;
    const i = state.select_cycle[key];
    state.select_cycle[key] = i + 1;
    return order[i] ?? order[order.length - 1] ?? '';
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
          if (mode === 'rollup') {
            const d = nextDomain('rollup');
            return state.rollup_by_domain[d] ?? [];
          }
          if (mode === 'count') {
            const d = nextDomain('count');
            return [{ n: state.total_matching_by_domain[d] ?? 0 }];
          }
          const d = nextDomain('list');
          return state.list_rows_by_domain[d] ?? [];
        });
      }),
      execute: vi.fn(async () => {
        const i = state.execute_cycle.counter++;
        // user-agg then mode-rows per domain, in domain order.
        const domain_idx = Math.floor(i / 2);
        const is_user_agg = i % 2 === 0;
        const d = state.execute_cycle.domain_order[domain_idx] ?? '';
        return is_user_agg
          ? state.user_agg_by_domain[d] ?? []
          : state.mode_rows_by_domain[d] ?? [];
      }),
    },
  };
});

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
      org_id: acting?.org_id ?? 'org_multi',
      org_type: acting?.org_type ?? 'aggregator',
      service_user_id: 'svc_aggregator_dpg',
    };
  });
  await app.register(aggregator_dashboard);
  return app;
};

const makeRollup = (
  status: string,
  n: number,
  apps_total = 0,
  pending = 0,
  shortlisted = 0,
  rejected = 0,
) => ({
  profile_status: status,
  n,
  apps_total,
  pending,
  shortlisted,
  rejected,
});

const makeUserAgg = (overrides: Record<string, number> = {}) => ({
  unique_users: 0,
  complete_profiles_count: 0,
  users_with_applications: 0,
  new_users_last_7_days: 0,
  total_applications: 0,
  ...overrides,
});

const seedTwoDomains = (
  scope: string[],
  per_domain_last_computed: Record<string, Date | null>,
) => {
  state.staleness_by_domain = {};
  for (const d of scope) {
    state.staleness_by_domain[d] = {
      refreshed: false,
      last_computed_at: per_domain_last_computed[d] ?? null,
    };
  }
  state.select_cycle.domain_order = scope;
  state.execute_cycle.domain_order = scope;
  state.rollup_by_domain = {
    seeker: [makeRollup('active', 5, 7, 4, 1, 2)],
    provider: [makeRollup('active', 2, 0, 0, 0, 0)],
  };
  state.user_agg_by_domain = {
    seeker: [makeUserAgg({ unique_users: 5, total_applications: 7 })],
    provider: [makeUserAgg({ unique_users: 2 })],
  };
  state.mode_rows_by_domain = {
    seeker: [{ via: 'bulk', n: 5 }],
    provider: [{ via: 'self', n: 2 }],
  };
  state.total_matching_by_domain = { seeker: 5, provider: 2 };
  state.list_rows_by_domain = { seeker: [], provider: [] };
};

const resetState = () => {
  state.staleness_calls = [];
  state.staleness_by_domain = {};
  state.staleness_default = {
    refreshed: false,
    last_computed_at: new Date('2026-06-01T00:00:00Z'),
  };
  state.org_metadata = JSON.stringify({ domains: ['seeker', 'provider'] });
  state.rollup_by_domain = {};
  state.user_agg_by_domain = {};
  state.mode_rows_by_domain = {};
  state.total_matching_by_domain = {};
  state.list_rows_by_domain = {};
  state.select_cycle = {
    domain_order: ['seeker', 'provider'],
    rollup_idx: 0,
    count_idx: 0,
    list_idx: 0,
  };
  state.execute_cycle = {
    domain_order: ['seeker', 'provider'],
    counter: 0,
  };
};

describe('GET /aggregator/dashboard — multi-domain', () => {
  beforeEach(() => {
    resetState();
  });

  it('200 by_domain has both seeker and provider keys when org has both configured', async () => {
    seedTwoDomains(['seeker', 'provider'], {
      seeker: new Date('2026-06-01T00:00:00Z'),
      provider: new Date('2026-06-01T00:00:00Z'),
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body.by_domain).sort()).toEqual(['provider', 'seeker']);
    expect(body.by_domain.seeker.rollup.items_total).toBe(5);
    expect(body.by_domain.provider.rollup.items_total).toBe(2);
  });

  it('?domain=seeker narrows scope to one key + one staleness call', async () => {
    seedTwoDomains(['seeker'], {
      seeker: new Date('2026-06-01T00:00:00Z'),
    });
    // metadata still configures both
    state.org_metadata = JSON.stringify({ domains: ['seeker', 'provider'] });
    state.select_cycle.domain_order = ['seeker'];
    state.execute_cycle.domain_order = ['seeker'];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard?domain=seeker',
    });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().by_domain)).toEqual(['seeker']);
    expect(state.staleness_calls).toEqual([
      { org_id: 'org_multi', domain: 'seeker' },
    ]);
  });

  it('Promise.all calls staleness once per scoped domain', async () => {
    seedTwoDomains(['seeker', 'provider'], {
      seeker: new Date('2026-06-01T00:00:00Z'),
      provider: new Date('2026-06-01T00:00:00Z'),
    });
    const app = await buildApp();
    await app.inject({ method: 'GET', url: '/dashboard' });
    expect(state.staleness_calls.length).toBe(2);
    expect(state.staleness_calls.map((c) => c.domain).sort()).toEqual([
      'provider',
      'seeker',
    ]);
    expect(state.staleness_calls.every((c) => c.org_id === 'org_multi')).toBe(
      true,
    );
  });

  it('metadata.last_computed_at is the earliest across domains', async () => {
    const earlier = new Date('2026-05-15T00:00:00Z');
    const later = new Date('2026-06-01T00:00:00Z');
    seedTwoDomains(['seeker', 'provider'], {
      seeker: later,
      provider: earlier,
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.json().metadata.last_computed_at).toBe(earlier.toISOString());
  });

  it('metadata.refreshed=true when any one domain was refreshed', async () => {
    seedTwoDomains(['seeker', 'provider'], {
      seeker: new Date('2026-06-01T00:00:00Z'),
      provider: new Date('2026-06-01T00:00:00Z'),
    });
    state.staleness_by_domain.provider = {
      refreshed: true,
      last_computed_at: new Date('2026-06-01T12:00:00Z'),
    };
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard' });
    expect(res.json().metadata.refreshed).toBe(true);
  });
});
