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
 * pins (spec: "cluster-disable zoom ~z14"). Task 6/7 make this
 * env-configurable (`MAP_CLUSTER_DISABLE_ZOOM`) and wire it into the actual
 * per-band marker caps; this constant is only the default used for the query
 * key's zoom band until that config lands.
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
