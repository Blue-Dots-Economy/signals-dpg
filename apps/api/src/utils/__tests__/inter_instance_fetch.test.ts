import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

// --- mocks (hoisted) -------------------------------------------------------
const { redisGet, redisSet } = vi.hoisted(() => ({
  redisGet: vi.fn(),
  redisSet: vi.fn(),
}));

vi.mock('@api/db/secondary/redis', () => ({
  redis: { get: redisGet, set: redisSet },
}));

// Everything is a *remote* peer: getCurrentApiBaseUrl never matches an
// instance_url below, so every count/page goes through global fetch.
vi.mock('@/config', () => ({
  getCurrentApiBaseUrl: () => 'http://self.local',
  apiConfig: { peer_fetch_timeout_ms: 3000 },
  peerConfig: {
    shared_secret: 'a'.repeat(48),
    auth_mode: 'permissive',
    token_window_seconds: 300,
  },
}));

vi.mock('@/utils/served_domain_guard', () => ({
  isServedDomainBinding: () => false,
}));

vi.mock('@/utils/item_fetch_runtime', () => ({
  countLocalItems: vi.fn(),
  fetchLocalItems: vi.fn(),
}));

vi.mock('@dpg/schemas', () => ({
  getDomainMinimumCacheTtlSeconds: () => 300,
}));

import {
  fetchItemsAcrossInstances,
  scatterGatherPage,
} from '../inter_instance_fetch.js';
import { apiConfig } from '@/config';

// --- fixtures --------------------------------------------------------------
const A = 'http://a.local';
const B = 'http://b.local';
const C = 'http://c.local';

const networkConfig = {
  instances: [
    { domain_id: 'student', instance_url: A },
    { domain_id: 'student', instance_url: B },
    { domain_id: 'student', instance_url: C },
  ],
  domains: [{ id: 'student' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const filters = {
  item_network: 'blue_dot',
  item_domain: 'student',
  limit: 20,
  offset: 0,
  lifecycle_filter: 'live_only',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const log = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

function pageItem(id: string) {
  return {
    item_id: id,
    item_network: 'blue_dot',
    item_domain: 'student',
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-01T00:00:00.000Z',
  };
}

function okJson(body: unknown) {
  return { ok: true, status: 200, statusText: 'OK', json: async () => body };
}

const countBody = (count: number) => okJson({ count });
const pageBody = (ids: string[]) =>
  okJson({
    meta: { total: ids.length, limit: 20, offset: 0 },
    items: ids.map(pageItem),
  });

// --- geo fixtures for scatter-gather ordering tests -------------------------
function geoItem(
  id: string,
  lat: number,
  createdAt = '2026-07-01T00:00:00.000Z'
) {
  return {
    item_id: id,
    item_network: 'blue_dot',
    item_domain: 'student',
    item_locations: [{ lat, lng: 0 }],
    created_at: createdAt,
    updated_at: createdAt,
  };
}

const geoPageBody = (items: ReturnType<typeof geoItem>[]) =>
  okJson({
    meta: { total: items.length, limit: 20, offset: 0 },
    items,
  });

/**
 * Build a fetch impl keyed on hostname. `behaviour[host]` decides count/page
 * outcome. `mode`: 'ok' | 'reject' (network error) | 'http500' | 'timeout'.
 */
function stubFetch(behaviour: Record<string, { mode: string; count?: number; ids?: string[] }>) {
  vi.stubGlobal(
    'fetch',
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.fn(async (url: any, opts: any) => {
      const u = url instanceof URL ? url : new URL(String(url));
      const b = behaviour[u.hostname];
      if (!b) throw new Error(`unexpected host ${u.hostname}`);
      if (b.mode === 'reject') throw new Error(`connection refused ${u.hostname}`);
      if (b.mode === 'http500') {
        return { ok: false, status: 500, statusText: 'Internal Server Error', json: async () => ({}) };
      }
      if (b.mode === 'timeout') {
        return new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () =>
            reject(new DOMException('The operation timed out.', 'TimeoutError'))
          );
        });
      }
      // ok
      return u.pathname.endsWith('/count_local') ? countBody(b.count ?? 0) : pageBody(b.ids ?? []);
    })
  );
}

const pageSetCalls = () =>
  redisSet.mock.calls.filter((c) => String(c[0]).startsWith('item-page'));

beforeEach(() => {
  redisGet.mockReset().mockResolvedValue(null);
  redisSet.mockReset().mockResolvedValue('OK');
  log.warn.mockReset();
  log.error.mockReset();
  apiConfig.peer_fetch_timeout_ms = 3000;
});

afterEach(() => vi.unstubAllGlobals());

describe('fetchItemsAcrossInstances — resilience (Part A)', () => {
  it('returns a partial aggregate when one peer count fails', async () => {
    stubFetch({
      'a.local': { mode: 'ok', count: 1, ids: ['a1'] },
      'b.local': { mode: 'reject' }, // count fails
      'c.local': { mode: 'ok', count: 1, ids: ['c1'] },
    });

    const result = await fetchItemsAcrossInstances({ networkConfig, filters, log });

    expect(result.meta.partial).toBe(true);
    expect(result.meta.unavailable_instances).toContain(B);
    const ids = result.items.map((i) => i.item_id).sort();
    expect(ids).toEqual(['a1', 'c1']);
    expect(pageSetCalls()).toHaveLength(0); // partial not cached
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ instanceUrl: B, phase: 'count' }),
      expect.any(String)
    );
  });

  it('returns a partial aggregate when one peer page fetch fails', async () => {
    stubFetch({
      'a.local': { mode: 'ok', count: 1, ids: ['a1'] },
      'b.local': { mode: 'ok', count: 1 }, // count ok, page 500
      'c.local': { mode: 'ok', count: 1, ids: ['c1'] },
    });
    // override b page to 500 by re-stubbing with a path-aware impl
    vi.stubGlobal(
      'fetch',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.fn(async (url: any) => {
        const u = url instanceof URL ? url : new URL(String(url));
        const isCount = u.pathname.endsWith('/count_local');
        if (u.hostname === 'b.local')
          return isCount
            ? countBody(1)
            : { ok: false, status: 500, statusText: 'ISE', json: async () => ({}) };
        if (u.hostname === 'a.local') return isCount ? countBody(1) : pageBody(['a1']);
        return isCount ? countBody(1) : pageBody(['c1']);
      })
    );

    const result = await fetchItemsAcrossInstances({ networkConfig, filters, log });

    expect(result.meta.partial).toBe(true);
    expect(result.meta.unavailable_instances).toContain(B);
    const ids = result.items.map((i) => i.item_id).sort();
    expect(ids).toEqual(['a1', 'c1']); // b's slice dropped
    expect(pageSetCalls()).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ instanceUrl: B, phase: 'page' }),
      expect.any(String)
    );
  });

  it('caches and reports complete when every peer succeeds', async () => {
    stubFetch({
      'a.local': { mode: 'ok', count: 1, ids: ['a1'] },
      'b.local': { mode: 'ok', count: 1, ids: ['b1'] },
      'c.local': { mode: 'ok', count: 1, ids: ['c1'] },
    });

    const result = await fetchItemsAcrossInstances({ networkConfig, filters, log });

    expect(result.meta.partial).toBe(false);
    expect(result.meta.unavailable_instances).toEqual([]);
    expect(result.items.map((i) => i.item_id).sort()).toEqual(['a1', 'b1', 'c1']);
    expect(pageSetCalls()).toHaveLength(1); // complete aggregate cached
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('drops a peer that exceeds PEER_FETCH_TIMEOUT_MS', async () => {
    apiConfig.peer_fetch_timeout_ms = 30;
    stubFetch({
      'a.local': { mode: 'ok', count: 1, ids: ['a1'] },
      'b.local': { mode: 'timeout' }, // never resolves → aborted
      'c.local': { mode: 'ok', count: 1, ids: ['c1'] },
    });

    const result = await fetchItemsAcrossInstances({ networkConfig, filters, log });

    expect(result.meta.partial).toBe(true);
    expect(result.meta.unavailable_instances).toContain(B);
    expect(result.items.map((i) => i.item_id).sort()).toEqual(['a1', 'c1']);
    expect(pageSetCalls()).toHaveLength(0);
  });

  it('normalizes a legacy cache hit (no partial fields) to partial:false', async () => {
    const legacyBlob = JSON.stringify({
      meta: { total: 1, limit: 20, offset: 0 },
      items: [pageItem('cached1')],
    });
    redisGet.mockImplementation(async (key: string) =>
      String(key).startsWith('item-page') ? legacyBlob : null
    );

    const result = await fetchItemsAcrossInstances({ networkConfig, filters, log });

    expect(result.meta.partial).toBe(false);
    expect(result.meta.unavailable_instances).toEqual([]);
    expect(result.items.map((i) => i.item_id)).toEqual(['cached1']);
    expect(pageSetCalls()).toHaveLength(0); // cache hit → no write
  });
});

describe('scatterGatherPage — pure merge (>1 active instance)', () => {
  it('merges two synthetic per-instance ordered lists into a globally nearest-first slice', async () => {
    const center = { lat: 0, lng: 0 };
    // Each "instance" already returns its own rows nearest-first, but the
    // true global order interleaves across instances.
    const fromA = [geoItem('a-near', 0.001), geoItem('a-far', 0.05)]; // ~111m, ~5.5km
    const fromB = [geoItem('b-near', 0.002), geoItem('b-far', 0.06)]; // ~222m, ~6.7km

    const fetchPage = vi.fn(async ({ instanceUrl }: { instanceUrl: string }) =>
      instanceUrl === A ? fromA : fromB
    );

    const result = await scatterGatherPage({
      activeInstances: [A, B],
      filters: { ...filters, item_latitude: 0, item_longitude: 0, offset: 0, limit: 2 },
      fetchPage,
    });

    // Global nearest-2 across the union, not a per-instance concatenation.
    expect(result.rows.map((r) => r.item_id)).toEqual(['a-near', 'b-near']);
    expect(result.unavailableInstances.size).toBe(0);

    // Each peer was asked for its own top [0, offset+limit) rows.
    expect(fetchPage).toHaveBeenCalledWith({
      instanceUrl: A,
      filters: expect.objectContaining({ offset: 0, limit: 2 }),
    });
    expect(fetchPage).toHaveBeenCalledWith({
      instanceUrl: B,
      filters: expect.objectContaining({ offset: 0, limit: 2 }),
    });
  });

  it('marks a rejecting peer unavailable and still merges the survivors', async () => {
    const fromA = [geoItem('a-near', 0.001), geoItem('a-far', 0.05)];
    const fetchPage = vi.fn(async ({ instanceUrl }: { instanceUrl: string }) => {
      if (instanceUrl === B) throw new Error('peer unreachable');
      return fromA;
    });

    const result = await scatterGatherPage({
      activeInstances: [A, B],
      filters: { ...filters, item_latitude: 0, item_longitude: 0, offset: 0, limit: 2 },
      fetchPage,
    });

    expect(result.unavailableInstances).toEqual(new Set([B]));
    expect(result.rows.map((r) => r.item_id)).toEqual(['a-near', 'a-far']);
  });

  it('falls back to recency-only ordering when no lat/lng center is present', async () => {
    const fromA = [geoItem('a1', 0, '2026-01-01T00:00:00.000Z')];
    const fromB = [geoItem('b1', 0, '2026-06-01T00:00:00.000Z')];
    const fetchPage = vi.fn(async ({ instanceUrl }: { instanceUrl: string }) =>
      instanceUrl === A ? fromA : fromB
    );

    const result = await scatterGatherPage({
      activeInstances: [A, B],
      filters: { ...filters, offset: 0, limit: 2 },
      fetchPage,
    });

    expect(result.rows.map((r) => r.item_id)).toEqual(['b1', 'a1']); // newer first
  });
});

describe('fetchItemsAcrossInstances — scatter-gather ordering (Part B, >1 active instance)', () => {
  const geoFilters = {
    ...filters,
    item_latitude: 0,
    item_longitude: 0,
    limit: 2,
    offset: 0,
  };

  it('returns the globally nearest page across active instances, not a per-instance block', async () => {
    // Each instance is locally nearest-first, but the true global nearest-2
    // interleaves a's and b's rows — a per-instance count-block plan would
    // instead return the first instance's rows verbatim.
    const requestBodies: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      'fetch',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.fn(async (url: any, opts: any) => {
        const u = url instanceof URL ? url : new URL(String(url));
        if (opts?.body) {
          requestBodies.push({ url: u.hostname + u.pathname, body: JSON.parse(opts.body) });
        }
        if (u.pathname.endsWith('/count_local')) {
          if (u.hostname === 'a.local') return countBody(2);
          if (u.hostname === 'b.local') return countBody(2);
          return countBody(1);
        }
        if (u.hostname === 'a.local') {
          return geoPageBody([geoItem('a-near', 0.001), geoItem('a-far', 0.05)]);
        }
        if (u.hostname === 'b.local') {
          return geoPageBody([geoItem('b-near', 0.002), geoItem('b-far', 0.06)]);
        }
        return geoPageBody([geoItem('c-mid', 0.003)]);
      })
    );

    const result = await fetchItemsAcrossInstances({
      networkConfig,
      filters: geoFilters,
      log,
    });

    expect(result.meta.total).toBe(5); // sum of per-instance counts, unchanged
    expect(result.meta.partial).toBe(false);
    expect(result.items.map((i) => i.item_id)).toEqual(['a-near', 'b-near']);

    // Every active instance was scattered its own top [0, offset+limit) page.
    const pageRequests = requestBodies.filter((r) => r.url.endsWith('/fetch_local'));
    expect(pageRequests).toHaveLength(3);
    for (const req of pageRequests) {
      expect(req.body).toMatchObject({ offset: 0, limit: 2 });
    }
    expect(pageSetCalls()).toHaveLength(1); // complete aggregate still cached
  });

  it('returns a partial aggregate when one peer page fetch fails during scatter-gather', async () => {
    vi.stubGlobal(
      'fetch',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.fn(async (url: any) => {
        const u = url instanceof URL ? url : new URL(String(url));
        if (u.pathname.endsWith('/count_local')) return countBody(2);
        if (u.hostname === 'b.local') {
          return { ok: false, status: 500, statusText: 'ISE', json: async () => ({}) };
        }
        if (u.hostname === 'a.local') {
          return geoPageBody([geoItem('a-near', 0.001), geoItem('a-far', 0.05)]);
        }
        return geoPageBody([geoItem('c-near', 0.0015)]);
      })
    );

    const result = await fetchItemsAcrossInstances({
      networkConfig,
      filters: geoFilters,
      log,
    });

    expect(result.meta.partial).toBe(true);
    expect(result.meta.unavailable_instances).toContain(B);
    // Global nearest-2 across the surviving a/c rows.
    expect(result.items.map((i) => i.item_id)).toEqual(['a-near', 'c-near']);
    expect(pageSetCalls()).toHaveLength(0); // partial never cached
  });
});
