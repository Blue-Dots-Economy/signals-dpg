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

  it('rounds the viewport into a bucket so a sub-threshold pan reuses the cache', async () => {
    vi.mocked(fetchNetworkMarkers).mockResolvedValue({
      meta: { total: 0, limit: 5000, offset: 0, partial: false, unavailable_instances: [] },
      markers: [],
    });

    const { result, rerender } = renderHook(
      ({ vp }: { vp: typeof viewport }) => useMapMarkers(network, [domains[0]], vp),
      { wrapper, initialProps: { vp: viewport } },
    );
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);

    // A tiny pan (well under the ~110m lat/lng bucket) must not trigger a
    // second fetch — it should collapse onto the same rounded query key.
    rerender({ vp: { lat: viewport.lat + 0.00003, lng: viewport.lng + 0.00003, radiusMeters: 3010 } });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(fetchNetworkMarkers).toHaveBeenCalledTimes(1);
  });
});
