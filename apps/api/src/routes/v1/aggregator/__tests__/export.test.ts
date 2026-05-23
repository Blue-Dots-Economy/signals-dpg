import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * Plan B Task 11 — unit tests for GET /api/v1/aggregator/dashboard/export.
 *
 * The route now:
 *   - Reads org.metadata.domains and 400s when missing.
 *   - Accepts ?domain= to narrow within the configured set; 400s otherwise.
 *   - Calls check_and_refresh_if_stale(org_id, domain) for each scoped
 *     domain in parallel before streaming the CSV.
 *   - Streams item_metrics rows ordered by (item_domain, item_id), so
 *     multi-domain output is grouped by domain.
 *   - Projects exactly the 20-column COLUMNS list (item_private_state is
 *     never included).
 *
 * Strategy: vi.mock the drizzle db client + staleness service. The select
 * mock branches on the projection: a `{ metadata: ... }` projection returns
 * the org row; everything else streams item_metrics list pages from the
 * `state.list_pages` queue.
 */

const state = {
  org_metadata: JSON.stringify({ domains: ['seeker'] }) as string | null,
  list_pages: [] as Array<Array<Record<string, unknown>>>,
  staleness_calls: [] as Array<{ org_id: string; domain: string }>,
};

vi.mock('@/services/metrics/staleness', () => ({
  check_and_refresh_if_stale: vi.fn(
    async (aggregator_id: string, domain: string) => {
      state.staleness_calls.push({ org_id: aggregator_id, domain });
      return { refreshed: false, last_computed_at: new Date() };
    },
  ),
  TTL_SECONDS: 3600,
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const orgChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.limit = () =>
      Promise.resolve(
        state.org_metadata === null
          ? [{ metadata: null }]
          : [{ metadata: state.org_metadata }],
      );
    return chain;
  };

  const listChain = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.offset = () =>
      Promise.resolve(state.list_pages.shift() ?? []);
    return chain;
  };

  return {
    db: {
      select: vi.fn((projection?: Record<string, unknown>) => {
        const keys = Object.keys(projection ?? {});
        if (keys.length === 1 && keys[0] === 'metadata') return orgChain();
        return listChain();
      }),
    },
  };
});

import { aggregator_export } from '../export.js';

const sample = (overrides: Record<string, unknown> = {}) => ({
  itemId: 'itm_1',
  itemDomain: 'seeker',
  itemType: 'profile_1.0',
  ownerUserId: 'usr_1',
  onboardedByOrgId: 'org_bbmp',
  onboardedVia: 'bulk',
  profileStatus: 'active',
  profileCompletionPct: 80,
  profileCreatedAt: new Date('2026-05-01T00:00:00Z'),
  profileLastUpdatedAt: new Date('2026-05-20T00:00:00Z'),
  ageDays: 30,
  applicationsTotal: 2,
  applicationsPending: 1,
  applicationsShortlisted: 0,
  applicationsRejected: 1,
  lastAppliedAt: new Date('2026-05-18T00:00:00Z'),
  lastShortlistedAt: null,
  lastRejectedAt: new Date('2026-05-19T00:00:00Z'),
  openings: null,
  actionableTags: ['no_recent_activity'],
  lastComputedAt: new Date(),
  itemPrivateState: { secret: 'should-never-leak' },
  ...overrides,
});

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
  await app.register(aggregator_export);
  return app;
};

const EXPECTED_HEADER =
  'item_id,item_domain,item_type,owner_user_id,onboarded_by_org_id,onboarded_via,' +
  'profile_status,profile_completion_pct,profile_created_at,profile_last_updated_at,' +
  'age_days,applications_total,applications_pending,applications_shortlisted,' +
  'applications_rejected,last_applied_at,last_shortlisted_at,last_rejected_at,' +
  'openings,actionable_tags';

describe('GET /aggregator/dashboard/export', () => {
  beforeEach(() => {
    state.org_metadata = JSON.stringify({ domains: ['seeker'] });
    state.list_pages = [];
    state.staleness_calls = [];
  });

  it('403 NOT_AGGREGATOR for network_service caller', async () => {
    const app = await buildApp({ org_type: 'network_service' });
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_AGGREGATOR');
    expect(state.staleness_calls).toHaveLength(0);
  });

  it('403 NOT_AGGREGATOR for voice caller', async () => {
    const app = await buildApp({ org_type: 'voice' });
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_AGGREGATOR');
  });

  it('400 NO_DOMAINS_CONFIGURED when org.metadata is null', async () => {
    state.org_metadata = null;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_DOMAINS_CONFIGURED');
    expect(state.staleness_calls).toHaveLength(0);
  });

  it('400 NO_DOMAINS_CONFIGURED when domains array is empty', async () => {
    state.org_metadata = JSON.stringify({ domains: [] });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('NO_DOMAINS_CONFIGURED');
  });

  it('400 DOMAIN_NOT_CONFIGURED when ?domain= is not in scope', async () => {
    state.org_metadata = JSON.stringify({ domains: ['seeker'] });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export?domain=provider',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('DOMAIN_NOT_CONFIGURED');
    expect(state.staleness_calls).toHaveLength(0);
  });

  it('200 returns text/csv with attachment header', async () => {
    state.list_pages = [[sample()]];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="participants_/,
    );
  });

  it('header line matches the 20-column COLUMNS list', async () => {
    state.list_pages = [[sample()]];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    const lines = res.body.trim().split('\n');
    expect(lines[0]).toBe(EXPECTED_HEADER);
    expect(lines[0].split(',')).toHaveLength(20);
  });

  it('CSV body has header row + one data row for single-domain caller', async () => {
    state.list_pages = [[sample()]];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('itm_1');
    expect(lines[1]).toContain('seeker');
    expect(lines[1]).toContain('profile_1.0');
    expect(lines[1]).toContain('usr_1');
    expect(lines[1]).toContain('active');
    expect(lines[1]).toContain('2026-05-01T00:00:00.000Z');
  });

  it('multi-domain export streams rows for every configured domain (sorted by domain)', async () => {
    state.org_metadata = JSON.stringify({ domains: ['seeker', 'provider'] });
    // Mock returns rows already ordered by (item_domain, item_id) — provider
    // sorts before seeker alphabetically.
    state.list_pages = [
      [
        sample({
          itemId: 'itm_prov_1',
          itemDomain: 'provider',
          itemType: 'job_1.0',
          openings: 3,
        }),
        sample({ itemId: 'itm_seek_1', itemDomain: 'seeker' }),
      ],
    ];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(3); // header + 2 data
    expect(lines[1]).toContain('itm_prov_1');
    expect(lines[1]).toContain('provider');
    expect(lines[2]).toContain('itm_seek_1');
    expect(lines[2]).toContain('seeker');
    // Both domains had staleness refreshed in parallel.
    expect(state.staleness_calls).toEqual([
      { org_id: 'org_bbmp', domain: 'seeker' },
      { org_id: 'org_bbmp', domain: 'provider' },
    ]);
  });

  it('?domain=seeker narrows scope to one domain', async () => {
    state.org_metadata = JSON.stringify({ domains: ['seeker', 'provider'] });
    state.list_pages = [[sample({ itemId: 'itm_seek_only' })]];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export?domain=seeker',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('itm_seek_only');
    // Only seeker had staleness refreshed.
    expect(state.staleness_calls).toEqual([
      { org_id: 'org_bbmp', domain: 'seeker' },
    ]);
  });

  it('?status=active filter passes through (test verifies route accepts it)', async () => {
    state.list_pages = [[sample({ profileStatus: 'active' })]];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export?status=active',
    });
    expect(res.statusCode).toBe(200);
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('active');
  });

  it('CSV escapes commas, quotes, and newlines via double-quotes', async () => {
    state.list_pages = [
      [
        sample({
          itemId: 'itm,with,commas',
          profileStatus: 'has "quotes"',
          actionableTags: ['line\nbreak', 'normal'],
        }),
      ],
    ];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.body).toContain('"itm,with,commas"');
    expect(res.body).toContain('"has ""quotes"""');
    expect(res.body).toContain('"line\nbreak|normal"');
  });

  it('actionable_tags array is pipe-joined', async () => {
    state.list_pages = [
      [
        sample({
          actionableTags: ['missing_phone_number', 'no_recent_activity'],
        }),
      ],
    ];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.body).toContain('missing_phone_number|no_recent_activity');
  });

  it('empty results: just the header row', async () => {
    state.list_pages = [[]];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(EXPECTED_HEADER);
  });

  it('paginates: stops when rows.length < PAGE_SIZE', async () => {
    const page1 = Array.from({ length: 5 }, (_, i) =>
      sample({ itemId: `itm_${i}` }),
    );
    state.list_pages = [page1];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(6); // 1 header + 5 data rows
  });

  it('passes acting_org.org_id + each domain to check_and_refresh_if_stale', async () => {
    state.org_metadata = JSON.stringify({ domains: ['seeker', 'provider'] });
    state.list_pages = [[]];
    const app = await buildApp({ org_id: 'org_xyz', org_type: 'aggregator' });
    await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(state.staleness_calls).toEqual([
      { org_id: 'org_xyz', domain: 'seeker' },
      { org_id: 'org_xyz', domain: 'provider' },
    ]);
  });

  it('item_private_state is never written to the CSV body', async () => {
    state.list_pages = [
      [sample({ itemPrivateState: { secret: 'should-never-leak' } })],
    ];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(res.body).not.toContain('should-never-leak');
    expect(res.body).not.toContain('item_private_state');
  });
});
