import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchNetworkMarkers, MAP_FETCH_LIMIT } from '@/lib/network-api';
import type { Marker } from '@/lib/network-api';
import type { DotNetworkSchema, DotNetworkDomain, MapViewport } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';
import { snapViewportForKey, padBbox, shouldRefetch, zoomBand } from '@/lib/map-viewport-snap';
import type { RawBbox, ZoomBand } from '@/lib/map-viewport-snap';
import { capForZoom } from '@/lib/map-caps';

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
  /**
   * Whether any active domain's `meta.total` (the server-side match count
   * *before* the `limit` cutoff) exceeds the zoom-band cap for the current
   * viewport (#203 map-serverside-search Task 6, `capForZoom`). Drives BOTH
   * the Task 5 refetch-on-zoom-in state machine (see `heldRef` below) and the
   * "N+ in this area — zoom in" over-dense indicator (`MapCountPill`) — a
   * zoom-in that drops the true total under the cap flips this back to
   * `false` on its own once the resulting refetch settles.
   */
  truncated: boolean;
  isLoading: boolean;
}

/** Refetch state held across renders for the bbox path (Task 5). */
interface HeldBboxState {
  /** The raw (unsnapped) bbox actually used for the last fetch's query key + request. */
  bbox: RawBbox;
  /** That bbox, inflated ~25% — the new bbox must stay inside this to skip a refetch. */
  paddedBbox: RawBbox;
  /** Whether any domain's last fetch reported `meta.total > capForZoom(zoom)`. */
  truncated: boolean;
  /**
   * The zoom band (`snapViewportForKey`'s `'clustered' | 'individual'`) the
   * last fetch was made under. A zoom that crosses this band (e.g. smoothly
   * zooming from clustered into individual pins) always forces a refetch at
   * the CURRENT bbox — see the `bandChanged` check below. Without it, a
   * band-crossing zoom-in whose tighter bbox happens to still be contained
   * in the old padded bbox would advance the query key (since the key's
   * zoom-band axis changed) but fetch the STALE wide bbox, because
   * `effectiveBbox` would otherwise stay pinned to the held one.
   */
  zoomBand: ZoomBand;
}

/**
 * Fetch map markers (`/network/item/markers`) for the visible domains within
 * a viewport, one cached query per domain via `useQueries` (mirrors the
 * per-domain `useQueries` pattern).
 *
 * `filters` is the active facet filter set (`item_state.*`, e.g.
 * `{ gender: ['female'] }`) — forwarded to the server as `item_state` and
 * folded into the query key so a filter change always produces a distinct
 * cache entry. Defaults to `{}` (no filters). `home-page.tsx` passes
 * `MapFiltersPanel`'s `selectedFields` (as `activeFieldFilters`) here (#203
 * map-serverside-search Task 7); this parameter's shape has been stable
 * since Task 4, which wired the key ahead of the panel actually being
 * connected to it.
 *
 * `search` (map-native-text-search) is the top-bar free-text query. It's
 * trimmed once, forwarded to the server as `q` (value-match against public
 * `item_state` fields, viewport-scoped — same semantics as the list's search),
 * and folded into the query key so a search change always produces a distinct
 * cache entry, mirroring `filters` above. Defaults to `''` (no search).
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

  // Bbox path (#203 map-serverside-search Task 4): both live map providers
  // now report `map.getBounds()` corners on every emit, so `viewport` has a
  // bbox in practice.
  const rawBbox: RawBbox | null =
    viewport &&
    viewport.minLat !== undefined &&
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

  // Refetch state machine (#203 map-serverside-search Task 5). `heldRef` is
  // only ever WRITTEN from the effect below (after a fetch settles), never
  // during render, so it always reflects the last completed fetch's outcome.
  const heldRef = React.useRef<HeldBboxState | null>(null);
  // The REAL current zoom band (not the held one) — a band crossing (e.g.
  // smoothly zooming from clustered into individual pins) must force a
  // refetch at the current, tighter bbox even when that bbox is otherwise
  // contained in the old padded one and the held result was complete: the
  // query key already advances on a band change (`snappedKey.zoomBand`
  // below), and if `effectiveBbox` didn't also advance here, the resulting
  // fetch would be scoped to the STALE wide bbox instead of the viewport the
  // user is actually looking at.
  const currentZoomBand = zoomBand(viewport?.zoom ?? 0);
  const bandChanged = heldRef.current !== null && currentZoomBand !== heldRef.current.zoomBand;
  const needsRefetch = !rawBbox
    ? false
    : !heldRef.current
      ? true // no prior fetch to compare against — must fetch
      : bandChanged ||
        shouldRefetch({
          newBbox: rawBbox,
          paddedBbox: heldRef.current.paddedBbox,
          lastTruncated: heldRef.current.truncated,
        });
  // The bbox actually used to build the query key + the request this render:
  // the real viewport bbox when refetching, or the last fetch's held bbox
  // when the new viewport is a contained zoom-in/pan over a complete result.
  // Holding it stable is what makes the skip work — React Query only
  // refetches on a query-key change, so an unchanged key here serves the
  // held marker set and lets the map provider re-cluster it locally instead
  // of hitting the network.
  const effectiveBbox: RawBbox | null = !rawBbox ? null : needsRefetch ? rawBbox : heldRef.current!.bbox;

  // Zoom-band marker cap (#203 map-serverside-search Task 6, `capForZoom`):
  // the bbox (live-map) path fetches `cap + 1` — one more than the cap the
  // truncation check below compares `meta.total` against, so a total that
  // exactly equals the cap still comes back as a complete (non-truncated)
  // set. The radius path (hand-built radius viewports — the list/tourist
  // callers that predate the bbox work) keeps requesting the older, larger
  // flat `MAP_FETCH_LIMIT` unchanged; unifying it into the zoom-band cap is
  // out of scope here (it has no clustering/individual-pin distinction to
  // band on).
  const cap = capForZoom(viewport?.zoom ?? 0);
  const limit = effectiveBbox ? cap + 1 : MAP_FETCH_LIMIT;

  // A snapped-bbox grid cell alone (Task 4) can't be trusted to force a new
  // query key here: a contained zoom-in can coincidentally snap to the SAME
  // grid cell as the held bbox even when the held result was truncated and
  // MUST be refetched (the "20k profiles in Bangalore → zoom into HSR
  // Layout" case). `bboxToken` is bumped exactly once per genuinely new
  // viewport bbox while the held result is truncated, guaranteeing the query
  // key changes in that case regardless of how the snap grid rounds it. It
  // is deliberately NOT bumped before the first fetch settles (`heldRef`
  // still null) so noisy initial viewport reports keep deduping the way
  // Task 4 intends, and not bumped for a plain contained+complete zoom-in
  // either (the whole point of holding `effectiveBbox` stable). Writing
  // these refs during render is the sanctioned "derived from a changed prop"
  // pattern (compare-then-conditionally-write), not an arbitrary side
  // effect — see https://react.dev/reference/react/useState#storing-information-from-previous-renders.
  // Safe under Strict Mode's dev-only double-render: the guard reads
  // `lastRawBboxKeyRef` BEFORE writing it, so if React invokes this render
  // twice for the same commit (same `rawBbox`), the first invocation's write
  // makes the second invocation's guard see `rawBboxKey === lastRawBboxKeyRef.current`
  // and skip the body entirely — no double-increment. It only ever mutates
  // once per commit that actually changed `rawBbox`, which is exactly the
  // "did a genuinely new viewport arrive" signal this needs; a duplicate
  // render for an unchanged `rawBbox` is a no-op both times.
  const bboxTokenRef = React.useRef(0);
  const lastRawBboxKeyRef = React.useRef<string | null | undefined>(undefined);
  if (rawBbox) {
    const rawBboxKey = `${rawBbox.minLat},${rawBbox.minLng},${rawBbox.maxLat},${rawBbox.maxLng}`;
    if (rawBboxKey !== lastRawBboxKeyRef.current) {
      lastRawBboxKeyRef.current = rawBboxKey;
      if (heldRef.current?.truncated === true) {
        bboxTokenRef.current += 1;
      }
    }
  }

  // The zoom band always reflects the REAL current zoom (not the held bbox)
  // so crossing the cluster-disable band still forces a new key even when
  // the bbox itself is held stable.
  const snappedKey = effectiveBbox ? snapViewportForKey({ ...effectiveBbox, zoom: viewport?.zoom }) : null;
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
        ? {
            snappedBbox: snappedKey.snappedBbox,
            zoomBand: snappedKey.zoomBand,
            bboxToken: bboxTokenRef.current,
            filters,
            q,
            limit,
          }
        : { latBucket, lngBucket, radiusBucket, filters, q, limit };
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
              // providers' first report has landed; radius otherwise). Uses
              // `effectiveBbox`, not the raw viewport, so a held/skipped
              // fetch and its query key always agree on what was requested.
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
              ...(Object.keys(filters).length > 0 ? { item_state: filters } : {}),
              ...(q ? { q } : {}),
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
  // `truncated` is decided per-domain and ORed together: if any active
  // domain's `meta.total` exceeds the zoom-band cap (#203 Task 6,
  // `capForZoom`), the whole aggregated result is treated as truncated —
  // both for the Task 5 refetch-on-zoom-in decision below and for the
  // over-dense "N+ in this area — zoom in" indicator this hook's caller
  // renders, so neither trusts a set that's only representative for some
  // domains.
  const aggregated = React.useMemo(() => {
    const markers: Marker[] = [];
    let total = 0;
    let partial = false;
    let truncated = false;
    for (const result of results) {
      if (result.data) {
        markers.push(...result.data.markers);
        total += result.data.meta.total;
        partial = partial || result.data.meta.partial;
        truncated = truncated || result.data.meta.total > cap;
      }
    }
    return { markers, total, partial, truncated };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dataSignature captures the results' data identity; cap is a cheap derived primitive listed explicitly
  }, [dataSignature, cap]);

  // Update the held refetch state (Task 5) once every active domain's query
  // for `effectiveBbox` has settled — in an effect, not during render, so
  // `heldRef` only ever reflects the LAST COMPLETED fetch's outcome. Reuses
  // `aggregated.truncated` (computed above from the same `results`) rather
  // than recomputing it, so the two can never disagree.
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
      zoomBand: currentZoomBand,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- effectiveBboxSignature + dataSignature (+ currentZoomBand, captured via closure) capture the relevant identity of effectiveBbox/results for this effect
  }, [effectiveBboxSignature, dataSignature, aggregated.truncated]);

  return { ...aggregated, isLoading: results.some((r) => r.isLoading) };
}
