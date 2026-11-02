import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { MapMarker } from '@/engine/types';
import { breakdownFromCounts } from '../cluster-breakdown';

vi.mock('../map-clusters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../map-clusters')>();
  return { ...actual, buildClusterIndex: vi.fn(actual.buildClusterIndex) };
});
import { buildClusterIndex, queryClusters } from '../map-clusters';
import type { ClusterView, MapClusterItem } from '../map-clusters';
import { useMapClusters } from '../use-map-clusters';

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
    const items = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 60), { maxZoom: 22 }), around(12));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cluster', count: 2 });
  });

  it('keeps two points apart once they have room', () => {
    const items = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 100), { maxZoom: 22 }), around(12));
    expect(items.map((i) => i.kind)).toEqual(['point', 'point']);
  });

  it('returns only items inside the view', () => {
    const markers = [marker('a#0', 28, 77), marker('b#0', 29, 78), marker('c#0', 10, 70)];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 22 }), around(12));
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
    const [item] = queryClusters(buildClusterIndex(markers, { maxZoom: 22 }), around(5));
    expect(item.kind === 'cluster' && item.breakdown).toEqual([
      { domain: 'seeker', count: 3 },
      { domain: 'provider', count: 2 },
    ]);
  });

  it('gives the zoom a cluster click should go to', () => {
    const [item] = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 60), { maxZoom: 22 }), around(12));
    expect(item.kind === 'cluster' && item.expansionZoom).toBeGreaterThan(12);
  });

  it('expands a small cluster at the maximum zoom', () => {
    const markers = [marker('a#0', 28.6, 77.4), marker('b#0', 28.6, 77.4), marker('c#0', 28.6, 77.4)];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 18 }), around(18));
    expect(items.map((i) => i.kind)).toEqual(['point', 'point', 'point']);
  });

  it('keeps a large same-spot group as one bubble at the maximum zoom', () => {
    const markers = Array.from({ length: 60 }, (_, i) => marker(`m${i}#0`, 28.6, 77.4));
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 18 }), around(18));
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'cluster', count: 60 });
  });

  it('counts points, not listings', () => {
    const markers = [marker('a#0', 28.0, 77.0), marker('a#1', 29.5, 78.5)];
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 22 }), around(12));
    expect(items.map((i) => i.kind)).toEqual(['point', 'point']);
  });

  it('handles a world-wide view', () => {
    const markers = Array.from({ length: 1000 }, (_, i) =>
      marker(`w${i}#0`, -60 + ((i * 7) % 120), -170 + ((i * 13) % 340)),
    );
    const items = queryClusters(buildClusterIndex(markers, { maxZoom: 22 }), {
      west: -200,
      south: -85,
      east: 200,
      north: 85,
      zoom: 1,
    });
    expect(count(items)).toBe(1000);
  });

  it('gives each item a stable key', () => {
    const items = queryClusters(buildClusterIndex(pointsAtPixelOffset(12, 100), { maxZoom: 22 }), around(12));
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
