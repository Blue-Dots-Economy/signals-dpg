import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchNetworkMarkers, MAP_FETCH_LIMIT } from '@/lib/network-api';
import type { Marker } from '@/lib/network-api';
import type { DotNetworkSchema, DotNetworkDomain, MapViewport } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import { snapViewportForKey, padBbox, shouldRefetch, zoomBand, clampBbox, bboxContains } from '@/lib/map-viewport-snap';
import type { RawBbox, ZoomBand } from '@/lib/map-viewport-snap';
import { capForZoom } from '@/lib/map-caps';
import { resolveFacetFieldLabels } from '@/lib/facet-fields';

// Design: docs/architecture/ui-map-markers-refetch.md
// Markers are cached ~90s client-side; `cache_ttl_seconds` sends the same
// intent to the server's cache.
const MAP_STALE_TIME_MS = 90 * 1000;

/** True when any of an item's locations falls inside `bbox`. */
function markerInBbox(
  m: Marker,
  bbox: { minLat: number; minLng: number; maxLat: number; maxLng: number },
): boolean {
  return (m.item_locations ?? []).some(
    (l) =>
      l.lat >= bbox.minLat &&
      l.lat <= bbox.maxLat &&
      l.lng >= bbox.minLng &&
      l.lng <= bbox.maxLng,
  );
}
const MAP_CACHE_TTL_SECONDS = 90;

// Radius-path cache key only: the cell is ~half the bucketed radius, so a pan
// of up to about half a screen reuses the entry and a zoom refetches. The
// request itself always sends the real, unrounded viewport.
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
  /**
   * Whether any active domain's `meta.total` exceeds the zoom-band cap
   * (`capForZoom`). Drives the refetch decision and the over-dense
   * "N+ in this area" indicator.
   */
  truncated: boolean;
  isLoading: boolean;
  /** True when a domain's markers request failed, as opposed to an empty area. */
  isError: boolean;
}

/** Outcome of the last completed bbox fetch. */
interface HeldBboxState {
  /** The raw (unsnapped) bbox used for the last fetch's key and request. */
  bbox: RawBbox;
  /** That bbox inflated 25%; a new bbox inside it may skip the refetch. */
  paddedBbox: RawBbox;
  /** Whether any domain's last fetch reported `meta.total > capForZoom(zoom)`. */
  truncated: boolean;
  /**
   * Whether that fetch returned no markers. An empty held result is always
   * refetched: every later viewport sits inside the padded bbox, so a held
   * empty set would strand the map blank until a reload.
   */
  empty: boolean;
  /** Zoom band of the last fetch; crossing it forces a refetch at the current bbox. */
  zoomBand: ZoomBand;
}

/**
 * Fetches map markers (`/network/item/markers`) for the visible domains within
 * a viewport, one cached query per domain.
 *
 * `filters` are facet filters (`item_state.*`) and `search` is the top-bar
 * free-text query, sent as `q` (matches public `item_state` fields within the
 * viewport). Both are part of the query key.
 */
export function useMapMarkers(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
  viewport: MapViewport | null,
  filters: Record<string, unknown> = {},
  search: string = '',
): UseMapMarkersResult {
  const q = search.trim();
  const active = network && viewport ? domains : [];

  // Route each active facet to the domains that can honour it. The server drops
  // an undeclared or private facet silently, so sending it to a domain without
  // that field would return that domain unfiltered. A domain that cannot
  // satisfy every active facet is not fetched at all.
  const facetRouting = React.useMemo(() => {
    const activeFields = Object.keys(filters);
    return new Map(
      active.map((domain) => {
        if (activeFields.length === 0) return [domain.id, { filters: {}, satisfiable: true }];
        const declared = resolveFacetFieldLabels([domain]);
        const applicable: Record<string, unknown> = {};
        let satisfiable = true;
        for (const field of activeFields) {
          if (field in declared) applicable[field] = filters[field];
          else satisfiable = false;
        }
        return [domain.id, { filters: applicable, satisfiable }];
      }),
    );
  }, [active, filters]);

  const rawBbox: RawBbox | null =
    viewport &&
    viewport.minLat !== undefined &&
    viewport.minLng !== undefined &&
    viewport.maxLat !== undefined &&
    viewport.maxLng !== undefined
      ? // Clamp first: a zoomed-out provider reports bounds beyond ±180° / ±90°,
        // which the markers endpoint rejects with a 400.
        clampBbox({
          minLat: viewport.minLat,
          minLng: viewport.minLng,
          maxLat: viewport.maxLat,
          maxLng: viewport.maxLng,
        })
      : null;

  // Written only from the effect below, so it reflects the last completed fetch.
  const heldRef = React.useRef<HeldBboxState | null>(null);
  // The current zoom band, not the held one: the key advances on a band change,
  // so the bbox must advance too or the fetch would use the stale wide bbox.
  const currentZoomBand = zoomBand(viewport?.zoom ?? 0);
  const bandChanged = heldRef.current !== null && currentZoomBand !== heldRef.current.zoomBand;
  const needsRefetch = !rawBbox
    ? false
    : !heldRef.current
      ? true // no prior fetch to compare against — must fetch
      : bandChanged ||
        heldRef.current.empty ||
        shouldRefetch({
          newBbox: rawBbox,
          paddedBbox: heldRef.current.paddedBbox,
          lastTruncated: heldRef.current.truncated,
        });
  // The bbox for this render's key and request: the real bbox when refetching,
  // otherwise the held one, so React Query serves the held set and the provider
  // re-clusters it locally.
  const effectiveBbox: RawBbox | null = !rawBbox ? null : needsRefetch ? rawBbox : heldRef.current!.bbox;

  // The bbox path fetches `cap + 1`, so a total exactly equal to the cap still
  // reads as complete. The radius path keeps the flat `MAP_FETCH_LIMIT`.
  const cap = capForZoom(viewport?.zoom ?? 0);
  const limit = effectiveBbox ? cap + 1 : MAP_FETCH_LIMIT;

  // A contained zoom-in can snap to the same grid cell as the held bbox and
  // leave the key unchanged. `bboxToken` is bumped once per new raw bbox while
  // the held result is truncated or empty, forcing a new key. Not bumped before
  // the first fetch settles, so initial viewport reports still dedupe. The
  // compare-then-write on refs is idempotent under StrictMode's double render.
  const bboxTokenRef = React.useRef(0);
  const lastRawBboxKeyRef = React.useRef<string | null | undefined>(undefined);
  if (rawBbox) {
    const rawBboxKey = `${rawBbox.minLat},${rawBbox.minLng},${rawBbox.maxLat},${rawBbox.maxLng}`;
    if (rawBboxKey !== lastRawBboxKeyRef.current) {
      lastRawBboxKeyRef.current = rawBboxKey;
      if (heldRef.current?.truncated === true || heldRef.current?.empty === true) {
        bboxTokenRef.current += 1;
      }
    }
  }

  // Uses the real current zoom so a band crossing changes the key even when the
  // bbox is held.
  const snappedKey = effectiveBbox ? snapViewportForKey({ ...effectiveBbox, zoom: viewport?.zoom }) : null;
  // Radius-bucket key for radius-only viewports.
  const buckets = viewport && !snappedKey ? viewportBuckets(viewport) : null;
  const latBucket = buckets?.latBucket ?? null;
  const lngBucket = buckets?.lngBucket ?? null;
  const radiusBucket = buckets?.radiusBucket ?? null;

  const results = useQueries({
    queries: active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      // Per-domain filters, so the key matches what is sent.
      const routed = facetRouting.get(domain.id) ?? { filters: {}, satisfiable: true };
      const domainFilters = routed.filters;
      const keyFilters = snappedKey
        ? {
            snappedBbox: snappedKey.snappedBbox,
            zoomBand: snappedKey.zoomBand,
            bboxToken: bboxTokenRef.current,
            filters: domainFilters,
            satisfiable: routed.satisfiable,
            q,
            limit,
          }
        : {
            latBucket,
            lngBucket,
            radiusBucket,
            filters: domainFilters,
            satisfiable: routed.satisfiable,
            q,
            limit,
          };
      return {
        queryKey: queryKeys.markers(network!.id, domain.id, keyFilters),
        queryFn: async ({ signal }: { signal: AbortSignal }) =>
          fetchNetworkMarkers(
            {
              item_network: network!.id,
              item_domain: domain.id,
              item_type: itemType,
              // Bbox and radius are mutually exclusive on the server. Uses
              // `effectiveBbox` so the request and its key agree.
              ...(effectiveBbox
                ? {
                    min_lat: effectiveBbox.minLat,
                    min_lng: effectiveBbox.minLng,
                    max_lat: effectiveBbox.maxLat,
                    max_lng: effectiveBbox.maxLng,
                  }
                : {
                    item_latitude: viewport!.lat,
                    item_longitude: viewport!.lng,
                    radius_meters: viewport!.radiusMeters,
                  }),
              ...(Object.keys(domainFilters).length > 0 ? { item_state: domainFilters } : {}),
              ...(q ? { q } : {}),
              limit,
              cache_ttl_seconds: MAP_CACHE_TTL_SECONDS,
            },
            signal,
          ),
        staleTime: MAP_STALE_TIME_MS,
        // Skipped rather than sent, because the server would drop the facet
        // and return this domain's pins unfiltered.
        enabled: routed.satisfiable,
      };
    }),
  });

  // Keeps the `markers` array reference stable across re-renders that don't
  // change any query's data, so the map does not re-plot every pin.
  const dataSignature = results.map((r) => `${r.status}:${r.dataUpdatedAt}`).join('|');
  // The bbox the user is looking at, which can differ from the one last fetched.
  const shownBbox =
    viewport?.minLat !== undefined &&
    viewport.minLng !== undefined &&
    viewport.maxLat !== undefined &&
    viewport.maxLng !== undefined
      ? {
          minLat: viewport.minLat,
          minLng: viewport.minLng,
          maxLat: viewport.maxLat,
          maxLng: viewport.maxLng,
        }
      : null;
  const shownBboxSignature = shownBbox
    ? `${shownBbox.minLat},${shownBbox.minLng},${shownBbox.maxLat},${shownBbox.maxLng}`
    : null;

  // Recounting from the markers is only sound when the fetch covers the whole
  // visible bbox. After a zoom-out, before the wider fetch lands, it does not,
  // so `meta.total` is used instead.
  const canRecount =
    shownBbox !== null &&
    effectiveBbox !== null &&
    bboxContains(effectiveBbox, {
      minLat: shownBbox.minLat,
      minLng: shownBbox.minLng,
      maxLat: shownBbox.maxLat,
      maxLng: shownBbox.maxLng,
    });

  const aggregated = React.useMemo(() => {
    const markers: Marker[] = [];
    let total = 0;
    let partial = false;
    let truncated = false;
    for (const result of results) {
      if (result.data) {
        markers.push(...result.data.markers);
        const serverTotal = result.data.meta.total;
        const domainTruncated = serverTotal > cap;
        partial = partial || result.data.meta.partial;
        truncated = truncated || domainTruncated;

        // Count what is on screen: a held result can describe a larger area than
        // the visible bbox. A non-truncated domain holds the complete set, so
        // filtering it gives the exact count; a truncated one keeps the server
        // total (the caller shows "N+" anyway).
        total +=
          canRecount && shownBbox && !domainTruncated
            ? result.data.markers.filter((m) => markerInBbox(m, shownBbox)).length
            : serverTotal;
      }
    }
    return { markers, total, partial, truncated };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataSignature captures the results' data identity; cap, shownBboxSignature and canRecount are cheap derived primitives listed explicitly
  }, [dataSignature, cap, shownBboxSignature, canRecount]);

  // Record the outcome once every active domain's query has settled.
  const effectiveBboxSignature = effectiveBbox
    ? `${effectiveBbox.minLat},${effectiveBbox.minLng},${effectiveBbox.maxLat},${effectiveBbox.maxLng}`
    : null;
  React.useEffect(() => {
    if (!effectiveBbox || results.length === 0) return;
    if (results.some((r) => r.isLoading)) return;
    if (!results.some((r) => r.data)) return;
    heldRef.current = {
      bbox: effectiveBbox,
      paddedBbox: padBbox(effectiveBbox),
      truncated: aggregated.truncated,
      empty: aggregated.markers.length === 0,
      zoomBand: currentZoomBand,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveBboxSignature + dataSignature (+ currentZoomBand, captured via closure) capture the relevant identity of effectiveBbox/results for this effect
  }, [effectiveBboxSignature, dataSignature, aggregated.truncated]);

  return {
    ...aggregated,
    isLoading: results.some((r) => r.isLoading),
    isError: results.some((r) => r.isError),
  };
}
