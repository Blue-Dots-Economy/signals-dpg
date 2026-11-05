import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MapMarker } from '@/engine/types';
import { breakdownFromCounts } from '../cluster-breakdown';

vi.mock('../map-clusters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../map-clusters')>();
  return { ...actual, buildClusterIndex: vi.fn(actual.buildClusterIndex) };
});
import { buildClusterIndex, queryClusters, resolveClusterRadiusPx } from '../map-clusters';
import type { ClusterView, MapClusterItem } from '../map-clusters';
import { useMapClusters } from '../use-map-clusters';
import * as runtimeEnv from '@/lib/runtime-env';

function marker(id: string, lat: number, lng: number, domain = 'seeker'): MapMarker {
  return { id, lat, lng, label: id, data: {}, precision: 'exact', domain };
}

function pointsAtPixelOffset(zoom: number, dxPx: number): MapMarker[] {
  const lngPerPx = 360 / (256 * 2 ** zoom);
  return [marker('a#0', 28.6, 77.4), marker('b#0', 28.6, 77.4 + dxPx * lngPerPx)];
}

const around = (zoom: number): ClusterView => ({ west: 76, south: 27, east: 79, north: 30, zoom });

const count = (items: MapClusterItem[]) =>
  items.reduce((sum, i) => sum + (i.kind === 'cluster' ? i.count : 1), 0);

describe('queryClusters', () => {
  it('merges two points closer than 80 screen pixels', () => {
    const items = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 60), { maxZoom: 22, radiusPx: 80 }), around(12));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cluster', count: 2 });
  });

  it('keeps two points apart once they have room', () => {
    const items = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 100), { maxZoom: 22, radiusPx: 80 }), around(12));
    expect(items.map((i) => i.kind)).toEqual(['point', 'point']);
  });

  it('merges points as far apart as a wider configured radius', () => {
    const items = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 100), { maxZoom: 22, radiusPx: 120 }), around(12));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cluster', count: 2 });
  });

  it('returns only items inside the view', () => {
    const markers = [marker('a#0', 28, 77), marker('b#0', 29, 78), marker('c#0', 10, 70)];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 22, radiusPx: 80 }), around(12));
    expect(count(items)).toBe(2);
  });

  it('counts per domain on each cluster', () => {
    const markers = [
      marker('s1#0', 28.6, 77.4, 'seeker'),
      marker('s2#0', 28.6, 77.4, 'seeker'),
      marker('s3#0', 28.6, 77.4, 'seeker'),
      marker('p1#0', 28.6, 77.4, 'provider'),
      marker('p2#0', 28.6, 77.4, 'provider'),
    ];
    const [item] = queryClusters(buildClusterIndex(markers, { maxZoom: 22, radiusPx: 80 }), around(5));
    expect(item.kind === 'cluster' && item.breakdown).toEqual([
      { domain: 'seeker', count: 3 },
      { domain: 'provider', count: 2 },
    ]);
  });

  it('keeps each cluster\'s domain counts its own when clusters merge at lower zooms', () => {
    const lngPerPx = 360 / (256 * 2 ** 12);
    const markers = [
      ...Array.from({ length: 3 }, (_, i) => marker(`s${i}#0`, 28.6, 77.4, 'seeker')),
      ...Array.from({ length: 2 }, (_, i) => marker(`p${i}#0`, 28.6, 77.4 + 120 * lngPerPx, 'provider')),
    ];
    const index = buildClusterIndex(markers, { maxZoom: 22, radiusPx: 80 });
    const atTwelve = queryClusters(index, around(12));
    for (const item of atTwelve) {
      if (item.kind !== 'cluster') continue;
      expect(item.breakdown.reduce((sum, b) => sum + b.count, 0)).toBe(item.count);
    }
    const merged = queryClusters(index, around(8));
    expect(merged).toHaveLength(1);
    expect(merged[0].kind === 'cluster' && merged[0].breakdown).toEqual([
      { domain: 'seeker', count: 3 },
      { domain: 'provider', count: 2 },
    ]);
  });

  it('gives the zoom a cluster click should go to', () => {
    const [item] = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 60), { maxZoom: 22, radiusPx: 80 }), around(12));
    expect(item.kind === 'cluster' && item.expansionZoom).toBeGreaterThan(12);
  });

  it('keeps a small same-spot group a bubble at the maximum zoom', () => {
    const markers = [marker('a#0', 28.6, 77.4), marker('b#0', 28.6, 77.4), marker('c#0', 28.6, 77.4)];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 18, radiusPx: 80 }), around(18));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cluster', count: 3 });
  });

  it('marks a bubble of points at one coordinate as an exact spot', () => {
    const markers = Array.from({ length: 5 }, (_, i) => marker(`m${i}#0`, 28.6, 77.4));
    const [item] = queryClusters(buildClusterIndex(markers, { maxZoom: 20, radiusPx: 80 }), around(12));
    expect(item.kind === 'cluster' && item.spot).toEqual({
      exact: true,
      bounds: { minLat: 28.6, minLng: 77.4, maxLat: 28.6, maxLng: 77.4 },
    });
  });

  it('marks points a few metres apart that never separate as a near spot', () => {
    const step = 1 / 111_320;
    const markers = Array.from({ length: 4 }, (_, i) => marker(`n${i}#0`, 28.6 + i * step, 77.4));
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 18, radiusPx: 80 }), around(18));
    expect(items).toHaveLength(1);
    expect(items[0].kind === 'cluster' && items[0].spot).toMatchObject({ exact: false });
  });

  it('draws listings 40 m apart as separate pins at the maximum zoom', () => {
    const markers = [marker('a#0', 28.6, 77.4), marker('b#0', 28.6 + 40 / 111_320, 77.4)];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 18, radiusPx: 80 }), around(18));
    expect(items.map((i) => i.kind)).toEqual(['point', 'point']);
  });

  it('zooms rather than explaining listings that separate at the maximum zoom', () => {
    const markers = [marker('a#0', 28.6, 77.4), marker('b#0', 28.6 + 40 / 111_320, 77.4)];
    const [item] = queryClusters(buildClusterIndex(markers, { maxZoom: 18, radiusPx: 80 }), around(16));
    expect(item).toMatchObject({ kind: 'cluster', count: 2, spot: null });
  });

  it('splits a loose bubble at the maximum zoom into its same-spot group and single pins', () => {
    const markers = [
      marker('a#0', 28.6, 77.4),
      marker('b#0', 28.6, 77.4, 'provider'),
      marker('c#0', 28.6, 77.4),
      marker('d#0', 28.6 + 40 / 111_320, 77.4),
    ];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 18, radiusPx: 80 }), around(18));
    const group = items.find((i) => i.kind === 'cluster');
    expect(group).toMatchObject({
      kind: 'cluster',
      count: 3,
      breakdown: [
        { domain: 'seeker', count: 2 },
        { domain: 'provider', count: 1 },
      ],
      spot: { exact: true },
    });
    expect(items.filter((i) => i.kind === 'point').map((i) => i.key)).toEqual(['p:d#0']);
  });

  it('keys a same-spot bubble by its listings, not by the order they were loaded in', () => {
    const markers = Array.from({ length: 4 }, (_, i) => marker(`m${i}#0`, 28.6, 77.4));
    const one = queryClusters(buildClusterIndex([marker('x#0', 29.5, 78.5), ...markers], { maxZoom: 20, radiusPx: 80 }), around(12));
    const two = queryClusters(buildClusterIndex([...markers].reverse(), { maxZoom: 20, radiusPx: 80 }), around(12));
    const key = (items: MapClusterItem[]) => items.find((i) => i.kind === 'cluster')?.key;
    expect(key(one)).toBe(key(two));
  });

  it('leaves spot empty for a bubble that splits by the maximum zoom', () => {
    const [item] = queryClusters(buildClusterIndex(pointsAtPixelOffset(15, 200), { maxZoom: 22, radiusPx: 80 }), around(12));
    expect(item).toMatchObject({ kind: 'cluster', count: 2, spot: null });
  });

  it('keeps a large same-spot group as one bubble at the maximum zoom', () => {
    const markers = Array.from({ length: 60 }, (_, i) => marker(`m${i}#0`, 28.6, 77.4));
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 18, radiusPx: 80 }), around(18));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cluster', count: 60 });
  });

  it('treats a zoom beyond the maximum as the maximum', () => {
    const big = Array.from({ length: 60 }, (_, i) => marker(`m${i}#0`, 28.6, 77.4));
    const small = [marker('a#0', 28.7, 77.5), marker('b#0', 28.7, 77.5)];
    const items = queryClusters(buildClusterIndex([...big, ...small], { maxZoom: 20, radiusPx: 80 }), around(22));
    expect(items.filter((i) => i.kind === 'cluster').map((i) => i.kind === 'cluster' && i.count).sort()).toEqual([2, 60]);
    expect(items.filter((i) => i.kind === 'point')).toHaveLength(0);
  });

  it('counts points, not listings', () => {
    const markers = [marker('a#0', 28.0, 77.0), marker('a#1', 29.5, 78.5)];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 22, radiusPx: 80 }), around(12));
    expect(items.map((i) => i.kind)).toEqual(['point', 'point']);
  });

  it('handles a world-wide view', () => {
    const markers = Array.from({ length: 1000 }, (_, i) =>
      marker(`w${i}#0`, -60 + ((i * 7) % 120), -170 + ((i * 13) % 340)),
    );
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 22, radiusPx: 80 }), {
      west: -200,
      south: -85,
      east: 200,
      north: 85,
      zoom: 1,
    });
    expect(count(items)).toBe(1000);
  });

  it('gives each item a stable key', () => {
    const items = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 100), { maxZoom: 22, radiusPx: 80 }), around(12));
    expect(items.map((i) => i.key).sort()).toEqual(['p:a#0', 'p:b#0']);
  });
});

describe('breakdownFromCounts', () => {
  it('orders domains by count and drops an unknown domain', () => {
    expect(breakdownFromCounts({ seeker: 1, provider: 4, '': 2 })).toEqual([
      { domain: 'provider', count: 4 },
      { domain: 'seeker', count: 1 },
    ]);
  });
});

describe('useMapClusters', () => {
  it('returns nothing until the map reports a view', () => {
    const { result } = renderHook(() => useMapClusters([marker('a#0', 28, 77)], null, { maxZoom: 22 }));
    expect(result.current).toEqual([]);
  });

  it('rebuilds the index only when the markers array changes', () => {
    const markers = [marker('a#0', 28, 77), marker('b#0', 29, 78)];
    vi.mocked(buildClusterIndex).mockClear();
    const { result, rerender } = renderHook(
      ({ m, v }: { m: MapMarker[]; v: ClusterView }) => useMapClusters(m, v, { maxZoom: 22 }),
      { initialProps: { m: markers, v: around(10) } },
    );
    rerender({ m: markers, v: around(11) });
    expect(buildClusterIndex).toHaveBeenCalledTimes(1);
    expect(count(result.current)).toBe(2);

    rerender({ m: [...markers], v: around(11) });
    expect(buildClusterIndex).toHaveBeenCalledTimes(2);
  });
});

function mockRuntimeEnv(values: Record<string, string | undefined>) {
  vi.spyOn(runtimeEnv, 'getRuntimeEnv').mockImplementation(
    ((k: string) => values[k]) as unknown as typeof runtimeEnv.getRuntimeEnv,
  );
}

describe('resolveClusterRadiusPx', () => {
  afterEach(() => vi.restoreAllMocks());

  it('reads VITE_MAP_CLUSTER_RADIUS_PX', () => {
    mockRuntimeEnv({ VITE_MAP_CLUSTER_RADIUS_PX: '120' });
    expect(resolveClusterRadiusPx()).toBe(120);
  });

  it.each([undefined, '', 'abc', '0', '12.5', '19', '301', '-80'])('falls back to 80 for %s', (raw) => {
    mockRuntimeEnv({ VITE_MAP_CLUSTER_RADIUS_PX: raw });
    expect(resolveClusterRadiusPx()).toBe(80);
  });
});

describe('useMapClusters radius setting', () => {
  afterEach(() => vi.restoreAllMocks());

  it('clusters with the configured radius and rebuilds when it changes', () => {
    const markers = pointsAtPixelOffset(12, 100);
    mockRuntimeEnv({ VITE_MAP_CLUSTER_RADIUS_PX: '120' });
    const { result, rerender } = renderHook(() => useMapClusters(markers, around(12), { maxZoom: 22 }));
    expect(result.current).toHaveLength(1);

    mockRuntimeEnv({});
    rerender();
    expect(result.current.map((i) => i.kind)).toEqual(['point', 'point']);
  });
});
