import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * Multi-domain unit tests for GET /api/v1/aggregator/dashboard.
 *
 * Covers the multi-domain shape: when org.metadata.domains has more than
 * one entry, by_domain contains one block per domain, staleness is checked
 * per domain (in parallel via Promise.all), and the top-level
 * last_computed_at is the earliest across the per-domain timestamps.
 *
 * build_domain_block calls db.execute twice per domain:
 *   1st: rollup aggregate row
 *   2nd: mode-wise counts
 * db.select is used for the org lookup, count query, and list rows only.
 */

interface StalenessOutcome {
  refreshed: boolean;
  last_computed_at: Date | null;
}

// Rollup row shape returned by db.execute (first call per domain).
interface RollupRow {
  total_items: number;
  complete_profiles: number;
  has_applications: number;
  s_new: number;
  s_active: number;
  s_at_risk: number;
  s_inactive: number;
  b_create: number;
  b_accept: number;
  b_reject: number;
  b_cancel: number;
  unique_users: number;
  total_actions: number;
  engaged_users: number;
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
  // Per-domain rollup row fixtures (single row per domain).
  rollup_row_by_domain: {} as Record<string, RollupRow>,
  // Per-domain mode rows fixtures.
  mode_rows_by_domain: {} as Record<string, Array<Record<string, unknown>>>,
  total_matching_by_domain: {} as Record<string, number>,
  list_rows_by_domain: {} as Record<string, Array<Record<string, unknown>>>,
  staleness_calls: [] as Array<{ org_id: string; domain: string }>,
  // db.select cycles — attributed by counter to domains in order.
  select_cycle: {
    domain_order: [] as string[],
    count_idx: 0,
    list_idx: 0,
  },
  // db.execute cycles: 2 calls per domain (rollup then mode rows).
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
    const limitOffsetChain = {
      offset: vi.fn(() => resolve()),
    };
    const orderByChain = {
      limit: vi.fn(() => limitOffsetChain),
    };
    const whereChain = {
      orderBy: vi.fn(() => orderByChain),
      limit: vi.fn(() => resolve()),
      then: (cb: (v: unknown) => unknown) => resolve().then(cb),
    };
    const fromChain: Record<string, unknown> = {
      where: vi.fn(() => whereChain),
    };
    return {
      from: vi.fn(() => fromChain),
    };
  };

  const nextDomain = (which: 'count' | 'list'): string => {
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
        let mode: 'org' | 'count' | 'list';
        if (keys.length === 1 && keys[0] === 'metadata') mode = 'org';
        else if (keys.length === 1 && keys[0] === 'n') mode = 'count';
        else mode = 'list';

        return makeChain(async () => {
          if (mode === 'org') return [{ metadata: state.org_metadata }];
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
        // 2 execute calls per domain: rollup (even) then mode rows (odd).
        const domain_idx = Math.floor(i / 2);
        const is_rollup = i % 2 === 0;
        const d = state.execute_cycle.domain_order[domain_idx] ?? '';
        if (is_rollup) {
          const row = state.rollup_row_by_domain[d];
          return row ? [row] : [{}];
        }
        return state.mode_rows_by_domain[d] ?? [];
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

const makeRollupRow = (overrides: Partial<RollupRow> = {}): RollupRow => ({
  total_items: 0,
  complete_profiles: 0,
  has_applications: 0,
  s_new: 0,
  s_active: 0,
  s_at_risk: 0,
  s_inactive: 0,
  b_create: 0,
  b_accept: 0,
  b_reject: 0,
  b_cancel: 0,
  unique_users: 0,
  total_actions: 0,
  engaged_users: 0,
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
  state.select_cycle.count_idx = 0;
  state.select_cycle.list_idx = 0;
  state.execute_cycle.domain_order = scope;
  state.execute_cycle.counter = 0;
  state.rollup_row_by_domain = {
    seeker: makeRollupRow({ total_items: 5, s_active: 5, unique_users: 5, total_actions: 7, engaged_users: 3, b_create: 7 }),
    provider: makeRollupRow({ total_items: 2, s_active: 2, unique_users: 2 }),
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
  state.rollup_row_by_domain = {};
  state.mode_rows_by_domain = {};
  state.total_matching_by_domain = {};
  state.list_rows_by_domain = {};
  state.select_cycle = {
    domain_order: ['seeker', 'provider'],
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
    expect(body.by_domain.seeker.rollup.total_items).toBe(5);
    expect(body.by_domain.provider.rollup.total_items).toBe(2);
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
