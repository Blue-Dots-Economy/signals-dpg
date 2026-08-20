/**
 * Snapping helpers for the map markers query key (#203 map-serverside-search
 * Task 4). Pure functions only — no React, no fetching — so Task 5's refetch
 * decision (padded-bbox containment + truncated-result rule) can reuse the
 * exact same snapping without importing anything hook-shaped.
 *
 * IMPORTANT: only the CACHE KEY is snapped/banded here. The request actually
 * sent to the server always uses the real, unrounded viewport (see
 * `useMapMarkers` / `fetchNetworkMarkers`) — snapping exists purely so a
 * sub-pixel pan or a same-band zoom reuses the same React Query entry instead
 * of busting the cache on noise.
 */

export interface RawBbox {
  minLat: number;
  minLng: number;
  maxLat: number;
  maxLng: number;
}

export type ZoomBand = 'clustered' | 'individual';

/**
 * Zoom level at/above which the map disables clustering and shows individual
 * pins (spec: "cluster-disable zoom ~z14"). This module stays pure/env-unaware
 * on purpose — it only owns the cache-key zoom band. `map-caps.ts` (#203
 * map-serverside-search Task 6) reads the env-configurable version of this
 * same threshold (`VITE_MAP_CLUSTER_DISABLE_ZOOM`, defaulting to this exact
 * value) and uses it to pick the actual per-band marker cap (`capForZoom`).
 */
export const DEFAULT_CLUSTER_DISABLE_ZOOM = 14;

/**
 * Floor for the snap grid cell (degrees), so a very small (very zoomed-in)
 * bbox doesn't collapse to a near-zero cell and re-key on floating-point
 * noise. ~110m at the equator.
 */
const MIN_SNAP_CELL_DEG = 0.001;

/**
 * Grid cell size for a given bbox span (an eighth of the larger lat/lng
 * side), rounded to the nearest power of two. The power-of-two rounding is
 * what makes `snapBbox` tolerant of a slight zoom-in/out that keeps
 * "essentially the same view": two bboxes whose spans are close (e.g. a
 * contained bbox from a small zoom) but not identical would otherwise derive
 * two subtly different cell sizes, which can round a corner near a cell
 * boundary to two different grid lines even though the corner barely moved —
 * bucketing the cell itself removes that sensitivity. Floored at
 * `MIN_SNAP_CELL_DEG` so a very small (very zoomed-in) bbox doesn't collapse
 * to a near-zero cell.
 */
function cellForSpan(spanDeg: number): number {
  const raw = Math.max(spanDeg / 8, MIN_SNAP_CELL_DEG);
  const bucketed = 2 ** Math.floor(Math.log2(raw));
  return Math.max(bucketed, MIN_SNAP_CELL_DEG);
}

/**
 * Snap a raw bbox to a coarse grid for use as a cache-key input. The grid
 * cell is derived from the bbox's OWN span (see `cellForSpan`) rather than a
 * fixed size, so a wide low-zoom viewport gets a coarse grid (a city-scale
 * pan reuses the entry) and a small high-zoom viewport gets a fine one (a
 * small pan still busts it) — mirroring the existing radius-relative
 * bucketing in `useMapMarkers`.
 */
export function snapBbox(bbox: RawBbox): RawBbox {
  const latSpan = Math.abs(bbox.maxLat - bbox.minLat);
  const lngSpan = Math.abs(bbox.maxLng - bbox.minLng);
  const cell = cellForSpan(Math.max(latSpan, lngSpan));
  const snap = (value: number) => Math.round(value / cell) * cell;
  return {
    minLat: snap(bbox.minLat),
    minLng: snap(bbox.minLng),
    maxLat: snap(bbox.maxLat),
    maxLng: snap(bbox.maxLng),
  };
}

/**
 * Bands a raw zoom level into `'clustered'` (below the cluster-disable zoom)
 * or `'individual'` (at/above it) — a coarser axis than the raw zoom for the
 * cache key, so zooming within the same band (e.g. 8 → 9) reuses the entry
 * while crossing the band (e.g. 13 → 14) doesn't.
 */
export function zoomBand(
  zoom: number,
  clusterDisableZoom: number = DEFAULT_CLUSTER_DISABLE_ZOOM,
): ZoomBand {
  return zoom >= clusterDisableZoom ? 'individual' : 'clustered';
}

/** The subset of `MapViewport` this module needs — avoids importing the full engine type. */
export interface ViewportBboxInput {
  minLat?: number;
  minLng?: number;
  maxLat?: number;
  maxLng?: number;
  zoom?: number;
}

/**
 * Builds the snapped-bbox + zoom-band inputs the markers query key snaps on,
 * from a viewport. Returns `null` when the viewport has no bbox (hand-built
 * radius-only viewports — existing tests, callers that predate this Task 4
 * bbox work), so callers fall back to the previous radius-bucket key shape.
 * A missing `zoom` bands as `0` (`'clustered'`) — the safest default given
 * the map never shows individual, unclustered pins before its first zoom
 * report.
 */
export function snapViewportForKey(
  viewport: ViewportBboxInput,
  clusterDisableZoom?: number,
): { snappedBbox: RawBbox; zoomBand: ZoomBand } | null {
  const { minLat, minLng, maxLat, maxLng, zoom } = viewport;
  if (
    minLat === undefined ||
    minLng === undefined ||
    maxLat === undefined ||
    maxLng === undefined
  ) {
    return null;
  }
  return {
    snappedBbox: snapBbox({ minLat, minLng, maxLat, maxLng }),
    zoomBand: zoomBand(zoom ?? 0, clusterDisableZoom),
  };
}

/**
 * Inflate a bbox by `factor` (default 0.25 = 25%) of its own span on each
 * axis, split evenly between both sides. Used by Task 5's refetch state
 * machine (`use-map-markers.ts`) to build the "padded" bbox that a zoom-in or
 * small pan must stay inside to skip a refetch — generous enough that a
 * genuine zoom-in still reads as "the same view", while a real pan (which
 * moves the bbox rather than just shrinking it) escapes the padding and
 * forces a refetch.
 */
export function padBbox(bbox: RawBbox, factor = 0.25): RawBbox {
  const latPad = (Math.abs(bbox.maxLat - bbox.minLat) * factor) / 2;
  const lngPad = (Math.abs(bbox.maxLng - bbox.minLng) * factor) / 2;
  return {
    minLat: bbox.minLat - latPad,
    minLng: bbox.minLng - lngPad,
    maxLat: bbox.maxLat + latPad,
    maxLng: bbox.maxLng + lngPad,
  };
}

/** Whether `inner` is fully contained within `outer` on both the lat and lng axes. */
export function bboxContains(outer: RawBbox, inner: RawBbox): boolean {
  return (
    outer.minLat <= inner.minLat &&
    inner.maxLat <= outer.maxLat &&
    outer.minLng <= inner.minLng &&
    inner.maxLng <= outer.maxLng
  );
}

export interface RefetchDecisionInput {
  /** The new viewport's raw (unsnapped) bbox. */
  newBbox: RawBbox;
  /** The padded bbox from the last fetch, or `null` before any fetch has happened. */
  paddedBbox: RawBbox | null;
  /** Whether the last fetch's result was truncated (`meta.total > cap`). */
  lastTruncated: boolean;
}

/**
 * The refetch decision (#203 map-serverside-search Task 5): refetch when
 * there's no prior fetch to compare against, when the new bbox escapes the
 * last fetch's padded bbox (a real pan, or a zoom-out), or when the last
 * fetch's result was truncated — so zooming into a previously over-dense area
 * (the "20k profiles in Bangalore → zoom into HSR Layout" case) always
 * re-queries the server rather than filtering the held, possibly
 * unrepresentative set. Otherwise (contained + the held set was complete),
 * the caller should skip the fetch and reuse the held markers.
 */
/**
 * Clamp a viewport bbox to real-world coordinates.
 *
 * Map providers report bounds that run past the poles and, when zoomed out
 * far enough to show more than one copy of the world, past ±180° of
 * longitude — Leaflet and Google both do it. The markers endpoint validates
 * `min_lng`/`max_lng` to [-180, 180] (`item_schemas.ts:90-93`), so those
 * reports were rejected outright with
 * `querystring/max_lng Too big: expected number to be <=180` and the map
 * rendered as if the area were simply empty.
 *
 * A range that wraps the antimeridian (`minLng > maxLng`) or spans a full
 * revolution collapses to the whole world, which is what the user is looking
 * at in that situation anyway.
 */
export function clampBbox(bbox: RawBbox): RawBbox {
  const minLat = Math.max(-90, Math.min(90, bbox.minLat));
  const maxLat = Math.max(-90, Math.min(90, bbox.maxLat));
  const spansWorld = bbox.maxLng - bbox.minLng >= 360 || bbox.minLng > bbox.maxLng;
  return spansWorld
    ? { minLat, minLng: -180, maxLat, maxLng: 180 }
    : {
        minLat,
        maxLat,
        minLng: Math.max(-180, Math.min(180, bbox.minLng)),
        maxLng: Math.max(-180, Math.min(180, bbox.maxLng)),
      };
}

export function shouldRefetch({ newBbox, paddedBbox, lastTruncated }: RefetchDecisionInput): boolean {
  if (paddedBbox === null) return true;
  if (lastTruncated) return true;
  return !bboxContains(paddedBbox, newBbox);
}
