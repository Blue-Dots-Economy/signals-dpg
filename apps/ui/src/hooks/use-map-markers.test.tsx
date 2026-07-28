import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import type { Marker, MarkersResponse } from '@/lib/network-api';
import { useMapMarkers } from './use-map-markers';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkMarkers: vi.fn(),
  MAP_FETCH_LIMIT: 5000,
}));
import { fetchNetworkMarkers } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const marker = (id: string, domain: string): Marker => ({
  item_id: id,
  item_domain: domain,
  item_instance_url: null,
  item_locations: [{ lat: 19, lng: 72 }],
});

const network = { id: 'blue_dot' } as unknown as DotNetworkSchema;
const domains = [
  { id: 'student', item_schemas: { 'profile_1.0': {} } },
  { id: 'mentor', item_schemas: { 'profile_1.0': {} } },
] as unknown as DotNetworkDomain[];
const viewport = { lat: 19.076, lng: 72.8777, radiusMeters: 3000 };

describe('useMapMarkers', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches per domain with lat/lng/radius+limit and merges markers/total/partial', async () => {
    vi.mocked(fetchNetworkMarkers).mockImplementation(async (q): Promise<MarkersResponse> => {
      if (q.item_domain === 'student') {
        return {
          meta: { total: 2, limit: 5000, offset: 0, partial: true, unavailable_instances: ['x'] },
          markers: [marker('a', 'student')],
        };
      }
      return {
        meta: { total: 1, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
        markers: [marker('b', 'mentor')],
      };
    });

    const { result } = renderHook(() => useMapMarkers(network, domains, viewport), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.markers.map((m) => m.item_id).sort()).toEqual(['a', 'b']);
    expect(result.current.total).toBe(3);
    expect(result.current.partial).toBe(true);

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({
        item_network: 'blue_dot',
        item_domain: 'student',
        item_type: 'profile_1.0',
        item_latitude: 19.076,
        item_longitude: 72.8777,
        radius_meters: 3000,
        limit: 5000,
        cache_ttl_seconds: 90,
      }),
      expect.anything(),
    );
    // Enum filtering is deferred in P4 — never sent from this hook.
    const call = vi.mocked(fetchNetworkMarkers).mock.calls[0][0];
    expect(call).not.toHaveProperty('item_state');
  });

  it('is disabled when viewport is null (no fetch)', () => {
    renderHook(() => useMapMarkers(network, domains, null), { wrapper });
    expect(fetchNetworkMarkers).not.toHaveBeenCalled();
  });

  it('is disabled when network is null (no fetch)', () => {
    renderHook(() => useMapMarkers(null, domains, viewport), { wrapper });
    expect(fetchNetworkMarkers).not.toHaveBeenCalled();
  });

  it('reuses the cache for a pan within the fetch radius but refetches for a large move (#203 §5.2 jank fix)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    // City-zoom viewport: ~10km radius → bucket cell ~5km. The fetch already
    // covers a ~10km circle, so panning a couple of km stays inside it and must
    // reuse the cache. (The previous fixed ~110m bucket refetched on every such
    // pan, which janked the map — this is the regression guard.)
    const cityVp = { lat: 19.076, lng: 72.8777, radiusMeters: 10000 };
    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof cityVp }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: cityVp } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // ~2.2km pan — would have busted the old fixed bucket, but stays within the
    // radius-relative cell → NO refetch.
    rerender({ vp: { ...cityVp, lat: cityVp.lat + 0.02 } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // ~11km move (bigger than the fetched radius) → new cell → refetch.
    rerender({ vp: { ...cityVp, lat: cityVp.lat + 0.1 } });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  // #203 map-serverside-search Task 4: once the viewport carries a bbox (both
  // live providers populate it now), the map sends the bbox to the server
  // instead of a client-computed radius, and the query key snaps on the bbox
  // + zoom band + active filters rather than the old lat/lng/radius buckets.
  const bboxViewport = {
    lat: 19.076,
    lng: 72.8777,
    radiusMeters: 3000,
    zoom: 8,
    minLat: 19.0,
    minLng: 72.0,
    maxLat: 19.5,
    maxLng: 72.5,
  };

  it('sends min_lat/min_lng/max_lat/max_lng (not lat/lng/radius) when the viewport has a bbox', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result } = renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({
        min_lat: bboxViewport.minLat,
        min_lng: bboxViewport.minLng,
        max_lat: bboxViewport.maxLat,
        max_lng: bboxViewport.maxLng,
      }),
      expect.anything(),
    );
    const call = vi.mocked(fetchNetworkMarkers).mock.calls[0][0];
    expect(call).not.toHaveProperty('item_latitude');
    expect(call).not.toHaveProperty('item_longitude');
    expect(call).not.toHaveProperty('radius_meters');
  });

  it('forwards the active facet filters as item_state when provided', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    renderHook(() => useMapMarkers(network, [domains[0]], bboxViewport, { gender: ['female'] }), {
      wrapper,
    });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalled());

    expect(fetchNetworkMarkers).toHaveBeenCalledWith(
      expect.objectContaining({ item_state: { gender: ['female'] } }),
      expect.anything(),
    );
  });

  it('reuses the cache for a same/contained bbox + same zoom band + same filters', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ vp, filters }: { vp: typeof bboxViewport; filters: Record<string, unknown> }) =>
        useMapMarkers(network, [domains[0]], vp, filters),
      { wrapper, initialProps: { vp: bboxViewport, filters: { gender: ['female'] } } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // Contained bbox, well within the same snapped grid cell, same filters → no refetch.
    const contained = {
      ...bboxViewport,
      minLat: bboxViewport.minLat + 0.01,
      minLng: bboxViewport.minLng + 0.01,
      maxLat: bboxViewport.maxLat - 0.01,
      maxLng: bboxViewport.maxLng - 0.01,
    };
    rerender({ vp: contained, filters: { gender: ['female'] } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);
  });

  it('refetches when a pan crosses a snapped grid cell', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    const panned = {
      ...bboxViewport,
      minLat: bboxViewport.minLat + 0.1,
      minLng: bboxViewport.minLng + 0.1,
      maxLat: bboxViewport.maxLat + 0.1,
      maxLng: bboxViewport.maxLng + 0.1,
    };
    rerender({ vp: panned });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  it('refetches when zoom crosses the cluster-disable band, even with the same bbox', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: { ...bboxViewport, zoom: 13 } } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ vp: { ...bboxViewport, zoom: 14 } });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  // #203 map-serverside-search Task 5: the padded-bbox + truncated-result
  // refetch state machine. `bboxViewport` spans 0.5deg on each axis, so its
  // padded bbox (25% inflate) is [18.9375, 19.5625] x [71.9375, 72.5625].
  const containedBbox = {
    ...bboxViewport,
    minLat: bboxViewport.minLat + 0.01,
    minLng: bboxViewport.minLng + 0.01,
    maxLat: bboxViewport.maxLat - 0.01,
    maxLng: bboxViewport.maxLng - 0.01,
  };

  it('does not refetch a contained zoom-in when the last result was complete (#203 Task 5)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 3, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ vp: containedBbox });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    // Held marker set is reused — no second network call.
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);
  });

  it('refetches a contained zoom-in when the last result was truncated (#203 Task 5, HSR-layout case)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      // Deliberately way over any plausible placeholder cap: a dense area
      // (e.g. 20k profiles in Bangalore) whose held set can't be trusted for
      // a zoomed-in sub-area.
      meta: { total: 200_000, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ vp: containedBbox });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  it('refetches a pan that escapes the padded bbox even when the last result was complete (#203 Task 5)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 3, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // Padded bbox is [18.9375, 19.5625] x [71.9375, 72.5625]; a +0.1 shift on
    // every corner pushes maxLat to 19.6, escaping it.
    const pannedOut = {
      ...bboxViewport,
      minLat: bboxViewport.minLat + 0.1,
      minLng: bboxViewport.minLng + 0.1,
      maxLat: bboxViewport.maxLat + 0.1,
      maxLng: bboxViewport.maxLng + 0.1,
    };
    rerender({ vp: pannedOut });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });

  it('refetches with the CURRENT (tighter) bbox when a zoom crosses the cluster-disable band, even if that bbox is still contained in the old padded bbox (#203 Task 5 fix)', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 3, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [marker('a', 'student')],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof bboxViewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: bboxViewport } }, // zoom: 8 → 'clustered' band
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // `containedBbox` (shrunk by 0.01 on every corner) is still fully inside
    // the old padded bbox [18.9375, 19.5625] x [71.9375, 72.5625] — a pure
    // pan/zoom-in with an unchanged band would SKIP the refetch. Crossing
    // into the 'individual' band (zoom 14) must force a refetch anyway, and
    // that refetch must use THIS tighter bbox, not the original wide one.
    const zoomedInAcrossBand = { ...containedBbox, zoom: 14 };
    rerender({ vp: zoomedInAcrossBand });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));

    const secondCall = vi.mocked(fetchNetworkMarkers).mock.calls[1][0];
    expect(secondCall).toEqual(
      expect.objectContaining({
        min_lat: zoomedInAcrossBand.minLat,
        min_lng: zoomedInAcrossBand.minLng,
        max_lat: zoomedInAcrossBand.maxLat,
        max_lng: zoomedInAcrossBand.maxLng,
      }),
    );
  });

  it('refetches when the active facet filters change, even with the same bbox and zoom', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ filters }: { filters: Record<string, unknown> }) =>
        useMapMarkers(network, [domains[0]], bboxViewport, filters),
      { wrapper, initialProps: { filters: { gender: ['female'] } } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    rerender({ filters: { gender: ['male'] } });
    await waitFor(() => expect(fetchNetworkMarkers).toHaveBeenCalledTimes(2));
  });
});
