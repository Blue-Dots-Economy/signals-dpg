import * as React from 'react';
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

// Count-first browsing (#203 §7): the per-domain `limit` sent when only the
// aggregate `meta.total` is needed, not the pins themselves. 1 (not 0) so the
// request stays a normal, well-formed markers query — servers/validators are
// not guaranteed to accept `limit: 0`.
const COUNT_ONLY_LIMIT = 1;

// Viewport bucketing (spec §8 flag-back: "rounded viewport bucket"). Only the
// CACHE KEY is bucketed — the request sent to the server always uses the real,
// unrounded viewport. The bucket cell scales with the fetch RADIUS: the markers
// fetch already covers a circle of ~radius around the center (viewport +
// margin), so a pan that stays well inside that circle can safely reuse the
// same fetched set. We size the cell at ~half the radius, so panning up to
// roughly half a screen reuses the cache; a bigger pan, or a zoom (which
// changes the radius bucket), lands in a new cell and refetches. A fixed
// fine-grained decimal bucket (the previous approach) re-fetched on almost
// every small city-zoom pan, which janked the map — this keys off the zoom
// level instead.
const RADIUS_BUCKET_STEP_METERS = 500;
const METERS_PER_DEG_LAT = 111_320;

function bucketRadius(radiusMeters: number): number {
  return Math.round(radiusMeters / RADIUS_BUCKET_STEP_METERS) * RADIUS_BUCKET_STEP_METERS;
}

/**
 * Bucket a viewport into stable integer cell indices for the cache key. The
 * cell size is ~half the (bucketed) radius, so small pans reuse the entry while
 * real moves/zooms produce a new key.
 */
function viewportBuckets(v: MapViewport): {
  latBucket: number;
  lngBucket: number;
  radiusBucket: number;
} {
  const radiusBucket = bucketRadius(v.radiusMeters);
  const cellMeters = Math.max(radiusBucket / 2, RADIUS_BUCKET_STEP_METERS);
  const latStepDeg = cellMeters / METERS_PER_DEG_LAT;
  const cosLat = Math.cos((v.lat * Math.PI) / 180) || 1;
  const lngStepDeg = cellMeters / (METERS_PER_DEG_LAT * cosLat);
  return {
    latBucket: Math.round(v.lat / latStepDeg),
    lngBucket: Math.round(v.lng / lngStepDeg),
    radiusBucket,
  };
}

interface UseMapMarkersResult {
  markers: Marker[];
  total: number;
  partial: boolean;
  isLoading: boolean;
}

interface UseMapMarkersOptions {
  /**
   * Anonymous count-first browsing (#203 §7): when true, request `limit: 1`
   * per domain instead of the full `MAP_FETCH_LIMIT`. The markers endpoint's
   * `meta.total` reflects the true match count regardless of `limit` (it's
   * produced by the network fetch layer's own count-first discovery, not by
   * `markers.length`), so this is a cheap way to get an aggregate count
   * without pulling — and rendering — the full pin set. The differing
   * `limit` also lands in a distinct query-key bucket, so a count-only query
   * never serves (or is served by) a normal full-pin query's cache entry.
   */
  countOnly?: boolean;
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
  options: UseMapMarkersOptions = {},
): UseMapMarkersResult {
  const limit = options.countOnly ? COUNT_ONLY_LIMIT : MAP_FETCH_LIMIT;
  const active = network && viewport ? domains : [];
  const buckets = viewport ? viewportBuckets(viewport) : null;
  const latBucket = buckets?.latBucket ?? null;
  const lngBucket = buckets?.lngBucket ?? null;
  const radiusBucket = buckets?.radiusBucket ?? null;

  const results = useQueries({
    queries: active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      return {
        queryKey: queryKeys.markers(network!.id, domain.id, {
          latBucket,
          lngBucket,
          radiusBucket,
          limit,
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
              limit,
              cache_ttl_seconds: MAP_CACHE_TTL_SECONDS,
            },
            signal,
          ),
        staleTime: MAP_STALE_TIME_MS,
      };
    }),
  });

  // Memoize the aggregation so a plain re-render (e.g. the map firing a viewport
  // report that doesn't change the bucketed key) returns the SAME `markers`
  // array reference — otherwise the map would re-resolve and re-plot every pin
  // on every render, janking pan/zoom. The signature captures each query's data
  // identity (`dataUpdatedAt`) so it recomputes only when a query's data
  // actually changes.
  const dataSignature = results.map((r) => `${r.status}:${r.dataUpdatedAt}`).join('|');
  const aggregated = React.useMemo(() => {
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
    return { markers, total, partial };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataSignature captures the results' data identity
  }, [dataSignature]);

  return { ...aggregated, isLoading: results.some((r) => r.isLoading) };
}
