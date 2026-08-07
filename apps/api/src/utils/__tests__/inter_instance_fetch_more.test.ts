import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { FastifyBaseLogger } from 'fastify';

/**
 * Companion to `inter_instance_fetch.test.ts` (which covers the remote-peer
 * resilience / scatter-gather ordering paths). This file covers the gaps that
 * file deliberately never enters:
 *
 *  - the LOCAL instance path (instanceUrl === getCurrentApiBaseUrl() AND the
 *    binding is served) → countLocalItems / fetchLocalItems / fetchLocalMarkers
 *    in-process instead of an HTTP peer call,
 *  - `getInstanceCount` on its own (count cache hit, count cache write TTL,
 *    remote non-2xx),
 *  - `buildPagePlan` slice arithmetic edges,
 *  - the cache-KEY geo/bbox bucketing (`#203`) — the other file's filters carry
 *    no coordinates at all, so the bucketing math is never reached,
 *  - the inter-instance TTL contract: the network-config domain minimum is a
 *    floor, a requested TTL only ever raises it (apps/api/CLAUDE.md),
 *  - the `marker-page` cache-hit short circuit.
 */

// --- mocks (hoisted) -------------------------------------------------------
const { redisGet, redisSet } = vi.hoisted(() => ({
  redisGet: vi.fn((_key: string): Promise<string | null> => Promise.resolve(null)),
  redisSet: vi.fn(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (..._args: any[]): Promise<string> => Promise.resolve('OK')
  ),
}));

const { minimumTtl, servedBinding } = vi.hoisted(() => ({
  minimumTtl: vi.fn((_config: unknown, _domain: string): number => 300),
  servedBinding: vi.fn((_network: string, _domain: string): boolean => true),
}));

const { countLocalItems, fetchLocalItems, fetchLocalMarkers } = vi.hoisted(() => ({
  countLocalItems: vi.fn(
    (_filters: unknown, _log?: unknown): Promise<number> => Promise.resolve(0)
  ),
  fetchLocalItems: vi.fn(
    (_filters: unknown, _log?: unknown): Promise<unknown> => Promise.resolve(null)
  ),
  fetchLocalMarkers: vi.fn(
    (_filters: unknown, _log?: unknown): Promise<unknown> => Promise.resolve(null)
  ),
}));

vi.mock('@api/db/secondary/redis', () => ({
  redis: { get: redisGet, set: redisSet },
}));

// 'http://self.local' is THIS instance, so it takes the in-process local path;
// 'http://peer.local' is remote and goes through global fetch.
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
  isServedDomainBinding: (network: string, domain: string) =>
    servedBinding(network, domain),
}));

vi.mock('@/utils/item_fetch_runtime', () => ({
  countLocalItems: (filters: unknown, log?: unknown) => countLocalItems(filters, log),
  fetchLocalItems: (filters: unknown, log?: unknown) => fetchLocalItems(filters, log),
  fetchLocalMarkers: (filters: unknown, log?: unknown) =>
    fetchLocalMarkers(filters, log),
}));

vi.mock('@dpg/schemas', () => ({
  getDomainMinimumCacheTtlSeconds: (config: unknown, domain: string) =>
    minimumTtl(config, domain),
}));

import {
  buildPagePlan,
  fetchItemsAcrossInstances,
  fetchMarkersAcrossInstances,
  getInstanceCount,
} from '../inter_instance_fetch.js';

// --- fixtures --------------------------------------------------------------
const SELF = 'http://self.local';
const PEER = 'http://peer.local';

const selfOnlyNetworkConfig = {
  instances: [{ domain_id: 'student', instance_url: SELF }],
  domains: [{ id: 'student' }],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const baseFilters = {
  item_network: 'blue_dot',
  item_domain: 'student',
  limit: 2,
  offset: 0,
  lifecycle_filter: 'live_only',
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

const log = { warn: vi.fn(), error: vi.fn() } as unknown as FastifyBaseLogger & {
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
};

const keysWithPrefix = (prefix: string) =>
  redisSet.mock.calls.map((c) => String(c[0])).filter((k) => k.startsWith(prefix));

const pageKeyFor = async (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  filters: any
) => {
  redisGet.mockClear();
  await fetchItemsAcrossInstances({
    networkConfig: selfOnlyNetworkConfig,
    filters,
    log,
  });
  const key = redisGet.mock.calls
    .map((c) => String(c[0]))
    .find((k) => k.startsWith('item-page'));
  if (!key) throw new Error('no item-page cache key was read');
  return key;
};

/** The bucketed filter payload embedded in an `item-page:*` cache key. */
const keyFilters = (key: string): Record<string, number | string | undefined> =>
  JSON.parse(key.slice(key.indexOf('{')));

beforeEach(() => {
  redisGet.mockReset().mockResolvedValue(null);
  redisSet.mockReset().mockResolvedValue('OK');
  minimumTtl.mockReset().mockReturnValue(300);
  servedBinding.mockReset().mockReturnValue(true);
  countLocalItems.mockReset().mockResolvedValue(1);
  fetchLocalItems.mockReset().mockResolvedValue({
    meta: { total: 1, limit: 2, offset: 0 },
    items: [
      {
        item_id: 'local-1',
        item_network: 'blue_dot',
        item_domain: 'student',
        created_at: new Date('2026-07-01T00:00:00.000Z'),
        updated_at: new Date('2026-07-02T00:00:00.000Z'),
      },
    ],
  });
  fetchLocalMarkers.mockReset().mockResolvedValue({
    meta: { total: 1, limit: 2, offset: 0 },
    markers: [
      {
        item_id: 'local-marker-1',
        item_domain: 'student',
        item_instance_url: SELF,
        item_locations: [{ lat: 1, lng: 1 }],
      },
    ],
  });
  log.warn.mockReset();
  log.error.mockReset();
  // Any HTTP call in these tests is a bug: everything here is the local path
  // unless a test explicitly re-stubs fetch.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown) => {
      throw new Error(`unexpected remote fetch to ${String(url)}`);
    })
  );
});

afterEach(() => vi.unstubAllGlobals());

describe('buildPagePlan', () => {
  it('returns no slices when there are no counts at all', () => {
    expect(buildPagePlan([], 0, 10)).toEqual([]);
  });

  it('skips zero-count instances without consuming any of the global cursor', () => {
    expect(
      buildPagePlan(
        [
          { instanceUrl: 'http://empty', count: 0 },
          { instanceUrl: 'http://full', count: 5 },
        ],
        0,
        3
      )
    ).toEqual([{ instanceUrl: 'http://full', offset: 0, limit: 3 }]);
  });

  it('splits a page that straddles two instances into per-instance local offsets', () => {
    expect(
      buildPagePlan(
        [
          { instanceUrl: 'http://a', count: 5 },
          { instanceUrl: 'http://b', count: 5 },
        ],
        3,
        4
      )
    ).toEqual([
      { instanceUrl: 'http://a', offset: 3, limit: 2 },
      { instanceUrl: 'http://b', offset: 0, limit: 2 },
    ]);
  });

  it('omits instances the requested window skips over entirely', () => {
    expect(
      buildPagePlan(
        [
          { instanceUrl: 'http://a', count: 2 },
          { instanceUrl: 'http://b', count: 2 },
          { instanceUrl: 'http://c', count: 2 },
        ],
        4,
        2
      )
    ).toEqual([{ instanceUrl: 'http://c', offset: 0, limit: 2 }]);
  });

  it('returns no slices when the offset is past the global total', () => {
    expect(buildPagePlan([{ instanceUrl: 'http://a', count: 2 }], 10, 5)).toEqual([]);
  });
});

describe('getInstanceCount', () => {
  it('returns the cached count without touching the local count query or writing back', async () => {
    redisGet.mockResolvedValue('42');

    const count = await getInstanceCount({
      instanceUrl: SELF,
      filters: baseFilters,
      cacheTtlSeconds: 300,
      log,
    });

    expect(count).toBe(42);
    expect(countLocalItems).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('counts in-process for the local served instance and caches with the given TTL', async () => {
    countLocalItems.mockResolvedValue(7);

    const count = await getInstanceCount({
      instanceUrl: SELF,
      filters: { ...baseFilters, text_search: { q: 'delhi', fields: ['city'] } },
      cacheTtlSeconds: 120,
      log,
    });

    expect(count).toBe(7);
    // text_search flows through to the local count path (#394) but paging
    // fields must not: the count key/query is limit/offset-free.
    const countArg = countLocalItems.mock.calls[0][0] as Record<string, unknown>;
    expect(countArg.text_search).toEqual({ q: 'delhi', fields: ['city'] });
    expect(Object.keys(countArg)).not.toContain('limit');
    expect(Object.keys(countArg)).not.toContain('offset');

    const [key, value, ex, ttl] = redisSet.mock.calls[0];
    expect(String(key)).toContain(`item-count:blue_dot:student:${SELF}`);
    expect(value).toBe('7');
    expect(ex).toBe('EX');
    expect(ttl).toBe(120);
  });

  it('goes remote for its own URL when the domain binding is not served here', async () => {
    servedBinding.mockReturnValue(false);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ count: 4 }),
      }))
    );

    const count = await getInstanceCount({
      instanceUrl: SELF,
      filters: baseFilters,
      cacheTtlSeconds: 300,
      log,
    });

    expect(count).toBe(4);
    expect(countLocalItems).not.toHaveBeenCalled();
    const target = new URL(String(vi.mocked(fetch).mock.calls[0][0]));
    expect(target.pathname).toBe('/api/v1/network/item/count_local');
  });

  it('throws (and caches nothing) when a remote peer answers non-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
      }))
    );

    await expect(
      getInstanceCount({
        instanceUrl: PEER,
        filters: baseFilters,
        cacheTtlSeconds: 300,
        log,
      })
    ).rejects.toThrow(`Failed to fetch count from ${PEER}: 503 Service Unavailable`);
    expect(redisSet).not.toHaveBeenCalled();
  });
});

describe('fetchItemsAcrossInstances — local single-instance path', () => {
  it('serves the page in-process and caches the complete aggregate', async () => {
    countLocalItems.mockResolvedValue(3);

    const result = await fetchItemsAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      log,
    });

    expect(result.meta).toEqual({
      total: 3,
      limit: 2,
      offset: 0,
      partial: false,
      unavailable_instances: [],
    });
    expect(result.items.map((item) => item.item_id)).toEqual(['local-1']);
    // buildPagePlan's slice for the only active instance is [0, 2).
    expect(fetchLocalItems.mock.calls[0][0]).toEqual(
      expect.objectContaining({ offset: 0, limit: 2 })
    );
    expect(keysWithPrefix('item-page')).toHaveLength(1);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('keeps Date columns from the local query as Date instances', async () => {
    const result = await fetchItemsAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      log,
    });

    expect(result.items[0].created_at).toBeInstanceOf(Date);
    expect(result.items[0].updated_at).toBeInstanceOf(Date);
  });

  it('fetches no page at all when the local instance counts zero', async () => {
    countLocalItems.mockResolvedValue(0);

    const result = await fetchItemsAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      log,
    });

    expect(result.items).toEqual([]);
    expect(result.meta.total).toBe(0);
    expect(fetchLocalItems).not.toHaveBeenCalled();
    // An empty result is still a *complete* aggregate, so it is cached.
    expect(keysWithPrefix('item-page')).toHaveLength(1);
  });

  it('ignores instances belonging to another domain', async () => {
    const result = await fetchItemsAcrossInstances({
      networkConfig: {
        instances: [
          { domain_id: 'employer', instance_url: PEER },
          { domain_id: 'student', instance_url: SELF },
        ],
        domains: [{ id: 'student' }, { id: 'employer' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      filters: baseFilters,
      log,
    });

    expect(result.meta.partial).toBe(false);
    expect(countLocalItems).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  it('revives a string cache hit into a Date', async () => {
    redisGet.mockImplementation(async (key: string) =>
      String(key).startsWith('item-page')
        ? JSON.stringify({
            meta: { total: 1, limit: 2, offset: 0 },
            items: [
              {
                item_id: 'cached-1',
                created_at: '2026-07-01T00:00:00.000Z',
                updated_at: '2026-07-01T00:00:00.000Z',
              },
            ],
          })
        : null
    );

    const result = await fetchItemsAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      log,
    });

    expect(result.items[0].created_at).toBeInstanceOf(Date);
    expect(countLocalItems).not.toHaveBeenCalled();
  });
});

describe('fetchItemsAcrossInstances — cache TTL comes from network config', () => {
  it('raises the TTL when the caller requests a longer one', async () => {
    await fetchItemsAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      requestedCacheTtlSeconds: 900,
      log,
    });

    for (const call of redisSet.mock.calls) {
      expect(call[3]).toBe(900);
    }
    expect(keysWithPrefix('item-page')).toHaveLength(1);
  });

  it('clamps a requested TTL below the domain minimum up to that minimum', async () => {
    await fetchItemsAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      requestedCacheTtlSeconds: 5,
      log,
    });

    for (const call of redisSet.mock.calls) {
      expect(call[3]).toBe(300);
    }
  });

  it('uses the domain minimum when the caller requests nothing', async () => {
    minimumTtl.mockReturnValue(45);

    await fetchItemsAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      log,
    });

    expect(minimumTtl).toHaveBeenCalledWith(selfOnlyNetworkConfig, 'student');
    for (const call of redisSet.mock.calls) {
      expect(call[3]).toBe(45);
    }
  });

  it('keys the page cache by TTL so two TTLs never share an entry', async () => {
    const shortTtlKey = await pageKeyFor(baseFilters);
    minimumTtl.mockReturnValue(1200);
    const longTtlKey = await pageKeyFor(baseFilters);

    expect(shortTtlKey).not.toBe(longTtlKey);
  });
});

describe('page cache key bucketing (#203)', () => {
  const geo = (lat: number, lng: number, radius?: number) => ({
    ...baseFilters,
    item_latitude: lat,
    item_longitude: lng,
    ...(radius !== undefined ? { radius_meters: radius } : {}),
  });

  const bbox = (minLat: number, minLng: number, maxLat: number, maxLng: number) => ({
    ...baseFilters,
    min_lat: minLat,
    min_lng: minLng,
    max_lat: maxLat,
    max_lng: maxLng,
  });

  it('buckets a sub-cell longitude change at the same latitude onto the same key', async () => {
    const a = await pageKeyFor(geo(12.9716, 77.5946, 1000));
    const b = await pageKeyFor(geo(12.9716, 77.595, 1000));

    expect(a).toBe(b);
  });

  it('snaps the center onto the bucket grid instead of keying the raw coordinates', async () => {
    const keyed = keyFilters(await pageKeyFor(geo(12.9716, 77.5946, 1000)));

    // cellMeters = max(radiusBucket / 2, 500) = 500 → ~0.00449 deg of latitude.
    expect(keyed.item_latitude).toBeCloseTo(12.9716134, 6);
    expect(keyed.item_latitude).not.toBe(12.9716);
    expect(keyed.item_longitude).toBeCloseTo(77.5954672, 6);
    expect(keyed.item_longitude).not.toBe(77.5946);
    expect(keyed.radius_meters).toBe(1000);
  });

  it('loses key reuse across a latitude change even inside one grid cell, because the longitude step is derived from the UNBUCKETED latitude', async () => {
    const a = await pageKeyFor(geo(12.9716, 77.5946, 1000));
    const b = await pageKeyFor(geo(12.97165, 77.5946, 1000));

    // Both centers snap to the same latitude cell...
    expect(keyFilters(a).item_latitude).toBe(keyFilters(b).item_latitude);
    // ...but lngStepDeg uses cos(raw latitude), so a latitude nudge rescales
    // the longitude grid and the snapped longitude shifts by ~1.6e-5 deg
    // (about 1.7 m) — same cell index, different value, different key. The
    // bucketing comment's "a pan/zoom that stays within a cell reuses the
    // cached aggregate" therefore only holds while the raw latitude is
    // byte-identical.
    expect(keyFilters(a).item_longitude).not.toBe(keyFilters(b).item_longitude);
    expect(keyFilters(a).item_longitude).toBeCloseTo(
      keyFilters(b).item_longitude as number,
      4
    );
    expect(a).not.toBe(b);
  });

  it('mints a different key once the center moves beyond the bucket cell', async () => {
    const a = await pageKeyFor(geo(12.9716, 77.5946, 1000));
    const b = await pageKeyFor(geo(13.4716, 78.0946, 1000));

    expect(a).not.toBe(b);
  });

  it('buckets the radius too, so sub-step radius changes reuse the entry', async () => {
    const a = await pageKeyFor(geo(12.9716, 77.5946, 1000));
    const b = await pageKeyFor(geo(12.9716, 77.5946, 1040));
    const wider = await pageKeyFor(geo(12.9716, 77.5946, 5000));

    expect(a).toBe(b);
    expect(a).not.toBe(wider);
  });

  it('still buckets the center when no radius is supplied', async () => {
    const a = await pageKeyFor(geo(12.9716, 77.5946));
    const b = await pageKeyFor(geo(12.9716, 77.595));
    const withRadius = await pageKeyFor(geo(12.9716, 77.5946, 1000));

    expect(a).toBe(b);
    // The default bucket (500 m) snaps to the same cell as an explicit 1000 m
    // radius, but radius_meters is only present in the key when the caller
    // actually sent one, so the two are still distinct cache identities.
    expect(keyFilters(a).item_latitude).toBe(keyFilters(withRadius).item_latitude);
    expect(keyFilters(a).radius_meters).toBeUndefined();
    expect(a).not.toBe(withRadius);
  });

  it('snaps bbox corners onto a grid scaled by the bbox span', async () => {
    const keyed = keyFilters(await pageKeyFor(bbox(12.91, 77.51, 13.11, 77.71)));

    // span 0.2 deg * BBOX_BUCKET_FRACTION 0.2 = a 0.04 deg grid.
    expect(keyed.min_lat).toBeCloseTo(12.92, 9);
    expect(keyed.min_lng).toBeCloseTo(77.52, 9);
    expect(keyed.max_lat).toBeCloseTo(13.12, 9);
    expect(keyed.max_lng).toBeCloseTo(77.72, 9);
  });

  it('mints a fresh key for a wholly different viewport', async () => {
    const a = await pageKeyFor(bbox(12.91, 77.51, 13.11, 77.71));
    const panned = await pageKeyFor(bbox(14.91, 79.51, 15.11, 79.71));

    expect(a).not.toBe(panned);
  });

  it('does not reuse a bbox key across a small pan, because the grid step is recomputed from the raw span', async () => {
    const a = await pageKeyFor(bbox(12.91, 77.51, 13.11, 77.71));
    const nudged = await pageKeyFor(bbox(12.911, 77.511, 13.111, 77.711));

    // Both pans land on the SAME grid cell (values agree to ~1e-12), yet
    // latStep/lngStep are derived from the raw span, whose float value shifts
    // with the corners — so the snapped corners differ in their low digits and
    // the cache key is not reused.
    expect(keyFilters(nudged).min_lat).toBeCloseTo(keyFilters(a).min_lat as number, 9);
    expect(keyFilters(nudged).max_lng).toBeCloseTo(keyFilters(a).max_lng as number, 9);
    expect(nudged).not.toBe(a);
  });

  it('leaves a degenerate (zero-span) bbox unbucketed', async () => {
    const degenerate = (lng: number) => ({
      ...baseFilters,
      min_lat: 12.9,
      max_lat: 12.9,
      min_lng: lng,
      max_lng: lng,
    });

    const a = await pageKeyFor(degenerate(77.5));
    const b = await pageKeyFor(degenerate(77.5001));

    // A non-positive span is left as-is rather than snapped to a grid, so two
    // near-identical degenerate boxes do NOT share a cache entry.
    expect(a).not.toBe(b);
  });

  it('is not affected by a partial bbox (only some corners present)', async () => {
    const a = await pageKeyFor({ ...baseFilters, min_lat: 12.9, min_lng: 77.5 });
    const b = await pageKeyFor({ ...baseFilters, min_lat: 12.9001, min_lng: 77.5 });

    expect(a).not.toBe(b);
  });
});

describe('fetchMarkersAcrossInstances — local path and cache', () => {
  it('serves markers in-process and caches under the distinct marker-page prefix', async () => {
    countLocalItems.mockResolvedValue(5);

    const result = await fetchMarkersAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      log,
    });

    expect(result.meta).toEqual({
      total: 5,
      limit: 2,
      offset: 0,
      partial: false,
      unavailable_instances: [],
    });
    expect(result.markers.map((marker) => marker.item_id)).toEqual([
      'local-marker-1',
    ]);
    expect(fetchLocalMarkers.mock.calls[0][0]).toEqual(
      expect.objectContaining({ offset: 0, limit: 2 })
    );
    expect(keysWithPrefix('marker-page')).toHaveLength(1);
    expect(keysWithPrefix('item-page')).toHaveLength(0);
  });

  it('short-circuits on a marker cache hit and reports it complete', async () => {
    redisGet.mockImplementation(async (key: string) =>
      String(key).startsWith('marker-page')
        ? JSON.stringify({
            meta: { total: 1, limit: 2, offset: 0 },
            markers: [{ item_id: 'cached-marker' }],
          })
        : null
    );

    const result = await fetchMarkersAcrossInstances({
      networkConfig: selfOnlyNetworkConfig,
      filters: baseFilters,
      log,
    });

    expect(result.markers.map((marker) => marker.item_id)).toEqual([
      'cached-marker',
    ]);
    expect(result.meta.partial).toBe(false);
    expect(result.meta.unavailable_instances).toEqual([]);
    expect(countLocalItems).not.toHaveBeenCalled();
    expect(fetchLocalMarkers).not.toHaveBeenCalled();
    expect(keysWithPrefix('marker-page')).toHaveLength(0);
  });

  it('does not cache a partial marker aggregate when a peer count fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      })
    );
    countLocalItems.mockResolvedValue(1);

    const result = await fetchMarkersAcrossInstances({
      networkConfig: {
        instances: [
          { domain_id: 'student', instance_url: SELF },
          { domain_id: 'student', instance_url: PEER },
        ],
        domains: [{ id: 'student' }],
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      filters: baseFilters,
      log,
    });

    expect(result.meta.partial).toBe(true);
    expect(result.meta.unavailable_instances).toEqual([PEER]);
    // Only the surviving instance contributes, and nothing is written under
    // the marker-page key.
    expect(result.markers.map((marker) => marker.item_id)).toEqual([
      'local-marker-1',
    ]);
    expect(keysWithPrefix('marker-page')).toHaveLength(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.objectContaining({ instanceUrl: PEER, phase: 'count' }),
      expect.any(String)
    );
  });
});
