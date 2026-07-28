import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchNetworkMarkers, MAP_FETCH_LIMIT } from '@/lib/network-api';
import type { Marker } from '@/lib/network-api';
import type { DotNetworkSchema, DotNetworkDomain, MapViewport } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import { snapViewportForKey } from '@/lib/map-viewport-snap';

// Map tier (spec §5.2 / §8): markers are lightweight pins, cached ~90s
// client-side, mirrored by `cache_ttl_seconds` sent to the server so the
// client's freshness intent lines up with the server's own cache knob.
const MAP_STALE_TIME_MS = 90 * 1000;
const MAP_CACHE_TTL_SECONDS = 90;

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

/**
 * Fetch map markers (`/network/item/markers`) for the visible domains within
 * a viewport, one cached query per domain via `useQueries` (mirrors the
 * per-domain `useQueries` pattern).
 *
 * `filters` is the active facet filter set (`item_state.*`, e.g.
 * `{ gender: ['female'] }`) — forwarded to the server as `item_state` and
 * folded into the query key so a filter change always produces a distinct
 * cache entry. Defaults to `{}` (no filters): the map filters panel isn't
 * wired to this hook yet (#203 map-serverside-search Task 7 does that); this
 * parameter exists from Task 4 on so the key shape is ready ahead of time.
 */
export function useMapMarkers(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
  viewport: MapViewport | null,
  filters: Record<string, unknown> = {},
): UseMapMarkersResult {
  const limit = MAP_FETCH_LIMIT;
  const active = network && viewport ? domains : [];

  // Bbox path (#203 map-serverside-search Task 4): both live map providers
  // now report `map.getBounds()` corners on every emit, so `viewport` has a
  // bbox in practice. The snapped-bbox + zoom-band key axes replace the old
  // lat/lng/radius buckets for this path — see `lib/map-viewport-snap.ts`.
  const snappedKey = viewport ? snapViewportForKey(viewport) : null;
  // Legacy radius-bucket fallback, kept for callers that hand-build a
  // radius-only `MapViewport` (existing tests, anything predating the bbox
  // work) — the request itself still sends the real, unrounded radius.
  const buckets = viewport && !snappedKey ? viewportBuckets(viewport) : null;
  const latBucket = buckets?.latBucket ?? null;
  const lngBucket = buckets?.lngBucket ?? null;
  const radiusBucket = buckets?.radiusBucket ?? null;

  const results = useQueries({
    queries: active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      const keyFilters = snappedKey
        ? { snappedBbox: snappedKey.snappedBbox, zoomBand: snappedKey.zoomBand, filters, limit }
        : { latBucket, lngBucket, radiusBucket, filters, limit };
      return {
        queryKey: queryKeys.markers(network!.id, domain.id, keyFilters),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchNetworkMarkers(
            {
              item_network: network!.id,
              item_domain: domain.id,
              item_type: itemType,
              // Bbox and radius are mutually exclusive on the server — send
              // whichever the viewport actually has (bbox once both
              // providers' first report has landed; radius otherwise).
              ...(snappedKey
                ? {
                    min_lat: viewport!.minLat,
                    min_lng: viewport!.minLng,
                    max_lat: viewport!.maxLat,
                    max_lng: viewport!.maxLng,
                  }
                : {
                    item_latitude: viewport!.lat,
                    item_longitude: viewport!.lng,
                    radius_meters: viewport!.radiusMeters,
                  }),
              ...(Object.keys(filters).length > 0 ? { item_state: filters } : {}),
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
