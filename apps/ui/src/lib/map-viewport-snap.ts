/**
 * Snapping helpers for the map markers query key, plus the pure refetch
 * decision used by `useMapMarkers`.
 *
 * Only the cache key is snapped/banded. The request sent to the server always
 * uses the real, unrounded viewport; snapping only lets a sub-pixel pan or a
 * same-band zoom reuse the same React Query entry.
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
 * pins. This module only owns the cache-key zoom band and stays env-unaware;
 * `map-caps.ts` reads the env-configurable threshold
 * (`VITE_MAP_CLUSTER_DISABLE_ZOOM`, defaulting to this value).
 */
export const DEFAULT_CLUSTER_DISABLE_ZOOM = 14;

/** Floor for the snap grid cell (degrees, ~110m at the equator) so a tiny bbox does not re-key on floating-point noise. */
const MIN_SNAP_CELL_DEG = 0.001;

/**
 * Grid cell size for a given bbox span: an eighth of the larger side, rounded
 * down to a power of two and floored at `MIN_SNAP_CELL_DEG`. Bucketing the
 * cell stops two nearly identical spans from deriving slightly different cells
 * and rounding the same corner to different grid lines.
 */
function cellForSpan(spanDeg: number): number {
  const raw = Math.max(spanDeg / 8, MIN_SNAP_CELL_DEG);
  const bucketed = 2 ** Math.floor(Math.log2(raw));
  return Math.max(bucketed, MIN_SNAP_CELL_DEG);
}

/**
 * Snap a raw bbox to a grid for use as a cache-key input. The cell scales with
 * the bbox's own span, so a wide low-zoom view gets a coarse grid and a small
 * high-zoom view a fine one.
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
 * Bands a zoom level into `'clustered'` (below the cluster-disable zoom) or
 * `'individual'` (at/above it), so zooming within a band reuses the cache
 * entry while crossing it does not.
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
 * Builds the snapped-bbox + zoom-band key inputs from a viewport. Returns
 * `null` when the viewport has no bbox (radius-only viewports), so callers use
 * the radius-bucket key instead. A missing `zoom` bands as `'clustered'`.
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
 * Inflate a bbox by `factor` of its own span on each axis, split evenly
 * between both sides. `use-map-markers.ts` skips a refetch while the new bbox
 * stays inside this padded bbox (a zoom-in or small pan); a real pan escapes it.
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
 * Clamp a viewport bbox to real-world coordinates.
 *
 * Map providers (Leaflet and Google) report bounds past the poles and, when
 * zoomed out far enough, past ±180° longitude. The markers endpoint rejects
 * longitudes outside [-180, 180], which made the map look empty. A range that
 * wraps the antimeridian (`minLng > maxLng`) or spans a full revolution
 * collapses to the whole world.
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

/**
 * Refetch when there is no prior fetch, when the new bbox escapes the last
 * fetch's padded bbox (a real pan or a zoom-out), or when the last result was
 * truncated, so zooming into an over-dense area always re-queries the server
 * instead of filtering an unrepresentative held set. Otherwise the caller
 * reuses the held markers.
 */
export function shouldRefetch({ newBbox, paddedBbox, lastTruncated }: RefetchDecisionInput): boolean {
  if (paddedBbox === null) return true;
  if (lastTruncated) return true;
  return !bboxContains(paddedBbox, newBbox);
}
