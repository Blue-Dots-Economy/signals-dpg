import { useQueries } from '@tanstack/react-query';
import { fetchNetworkMarkers, MAP_FETCH_LIMIT } from '@/lib/network-api';
import type { Marker } from '@/lib/network-api';
import type { DotNetworkSchema, DotNetworkDomain, MapViewport } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

// Map tier (spec §5.2 / §8): markers are lightweight pins, cached ~90s
// client-side, mirrored by `cache_ttl_seconds` sent to the server so the
// client's freshness intent lines up with the server's own cache knob.
const MAP_STALE_TIME_MS = 90 * 1000;
const MAP_CACHE_TTL_SECONDS = 90;

// Viewport bucketing (spec §8 flag-back: "rounded viewport bucket"). A tiny
// pan or a sub-pixel radius change shouldn't bust the per-domain query cache
// and refire a network round trip, so only the CACHE KEY is bucketed — the
// actual request sent to the server (below) always uses the real, unrounded
// viewport. Lat/lng are rounded to the nearest 3 decimal places (~110m of
// precision at the equator, well inside typical marker clustering tolerance)
// and the radius to the nearest 500m step. Both use round-to-nearest (not
// floor/ceil) so a small delta in either direction from a bucket boundary
// still lands in the same bucket.
const LAT_LNG_BUCKET_DECIMALS = 3;
const RADIUS_BUCKET_STEP_METERS = 500;

function bucketCoordinate(value: number): number {
  const factor = 10 ** LAT_LNG_BUCKET_DECIMALS;
  return Math.round(value * factor) / factor;
}

function bucketRadius(radiusMeters: number): number {
  return Math.round(radiusMeters / RADIUS_BUCKET_STEP_METERS) * RADIUS_BUCKET_STEP_METERS;
}

interface UseMapMarkersResult {
  markers: Marker[];
  total: number;
  partial: boolean;
  isLoading: boolean;
}

/**
 * Fetch map markers (`/network/item/markers`) for the visible domains within
 * a viewport, one cached query per domain via `useQueries` (mirrors the
 * per-domain `useQueries` pattern). Map enum/state filtering is
 * DEFERRED in P4 (#203 scope decision) — this hook only ever sends viewport +
 * domain + type + limit; it must never take or forward `item_state`.
 */
export function useMapMarkers(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
  viewport: MapViewport | null,
): UseMapMarkersResult {
  const active = network && viewport ? domains : [];
  const latBucket = viewport ? bucketCoordinate(viewport.lat) : null;
  const lngBucket = viewport ? bucketCoordinate(viewport.lng) : null;
  const radiusBucket = viewport ? bucketRadius(viewport.radiusMeters) : null;

  const results = useQueries({
    queries: active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      return {
        queryKey: queryKeys.markers(network!.id, domain.id, {
          latBucket,
          lngBucket,
          radiusBucket,
          limit: MAP_FETCH_LIMIT,
        }),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchNetworkMarkers(
            {
              item_network: network!.id,
              item_domain: domain.id,
              item_type: itemType,
              item_latitude: viewport!.lat,
              item_longitude: viewport!.lng,
              radius_meters: viewport!.radiusMeters,
              limit: MAP_FETCH_LIMIT,
              cache_ttl_seconds: MAP_CACHE_TTL_SECONDS,
            },
            signal,
          ),
        staleTime: MAP_STALE_TIME_MS,
      };
    }),
  });

  const markers: Marker[] = [];
  let total = 0;
  let partial = false;
  for (const result of results) {
    if (result.data) {
      markers.push(...result.data.markers);
      total += result.data.meta.total;
      partial = partial || result.data.meta.partial;
    }
  }

  return { markers, total, partial, isLoading: results.some((r) => r.isLoading) };
}
