import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
} from 'fastify-type-provider-zod';

/**
 * Plan 3 Task 10 — tests for GET /api/v1/aggregator/dashboard/export.
 *
 * Mocks the drizzle db chain and the staleness service so the route can
 * be exercised without a real DB. The chain consumes the queued
 * `state.list_pages` one-at-a-time; the implementation pages until it
 * sees `rows.length < PAGE_SIZE` and exits, so a short queue is enough.
 */

const state = {
  list_pages: [] as Array<Array<Record<string, unknown>>>,
  staleness_calls: 0,
  staleness_last_arg: '' as string,
};

vi.mock('@/services/metrics/staleness', () => ({
  check_and_refresh_if_stale: vi.fn(async (aggregator_id: string) => {
    state.staleness_calls++;
    state.staleness_last_arg = aggregator_id;
    return { refreshed: false, last_computed_at: new Date() };
  }),
  TTL_SECONDS: 3600,
}));

vi.mock('@api/db/postgres/drizzle_config', () => {
  const selectFn = () => {
    const chain: Record<string, unknown> = {};
    chain.from = () => chain;
    chain.where = () => chain;
    chain.orderBy = () => chain;
    chain.limit = () => chain;
    chain.offset = () =>
      Promise.resolve(state.list_pages.shift() ?? []);
    return chain;
  };
  return { db: { select: selectFn } };
});

import { aggregator_export } from '../export.js';

const sample = (overrides: Record<string, unknown> = {}) => ({
  userId: 'usr_1',
  onboardedByOrgId: 'org_bbmp',
  onboardedVia: 'bulk',
  profileStatus: 'active',
  profileCompletionPct: 80,
  profileCreatedAt: new Date('2026-05-01T00:00:00Z'),
  profileLastUpdatedAt: new Date('2026-05-20T00:00:00Z'),
  ageDays: 30,
  applicationsPending: 1,
  applicationsAccepted: 0,
  applicationsRejected: 1,
  applicationsTotal: 2,
  actionableTags: ['no_recent_activity'],
  lastComputedAt: new Date(),
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

describe('GET /aggregator/dashboard/export', () => {
  beforeEach(() => {
    state.list_pages = [];
    state.staleness_calls = 0;
    state.staleness_last_arg = '';
  });

  it('403 NOT_AGGREGATOR for network_service caller', async () => {
    const app = await buildApp({ org_type: 'network_service' });
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('NOT_AGGREGATOR');
    expect(state.staleness_calls).toBe(0);
  });

  it('403 NOT_AGGREGATOR for voice caller', async () => {
    const app = await buildApp({ org_type: 'voice' });
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    expect(res.statusCode).toBe(403);
  });

  it('200 returns text/csv with attachment header', async () => {
    state.list_pages = [[sample()]];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toMatch(
      /attachment; filename="participants_/,
    );
  });

  it('CSV body has header row + one data row', async () => {
    state.list_pages = [[sample()]];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      'user_id,profile_status,profile_completion_pct,profile_created_at,profile_last_updated_at,age_days,applications_pending,applications_accepted,applications_rejected,applications_total,actionable_tags',
    );
    expect(lines[1]).toContain('usr_1');
    expect(lines[1]).toContain('active');
    expect(lines[1]).toContain('80');
    expect(lines[1]).toContain('2026-05-01T00:00:00.000Z');
  });

  it('CSV escapes commas, quotes, and newlines via double-quotes', async () => {
    state.list_pages = [
      [
        sample({
          userId: 'usr,with,commas',
          profileStatus: 'has "quotes"',
          actionableTags: ['line\nbreak', 'normal'],
        }),
      ],
    ];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    expect(res.body).toContain('"usr,with,commas"');
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
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    expect(res.body).toContain('missing_phone_number|no_recent_activity');
  });

  it('empty results: just the header row', async () => {
    state.list_pages = [[]];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    const lines = res.body.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith('user_id,')).toBe(true);
  });

  it('paginates: stops when rows.length < PAGE_SIZE', async () => {
    // First page of 5 rows is < PAGE_SIZE=5000 so loop exits immediately.
    const page1 = Array.from({ length: 5 }, (_, i) =>
      sample({ userId: `usr_${i}` }),
    );
    state.list_pages = [page1];
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/dashboard/export',
    });
    const lines = res.body.trim().split('\n');
    // 1 header + 5 data rows.
    expect(lines).toHaveLength(6);
  });

  it('calls check_and_refresh_if_stale with the acting org_id', async () => {
    state.list_pages = [[]];
    const app = await buildApp({ org_id: 'org_xyz' });
    await app.inject({ method: 'GET', url: '/dashboard/export' });
    expect(state.staleness_calls).toBe(1);
    expect(state.staleness_last_arg).toBe('org_xyz');
  });
});
