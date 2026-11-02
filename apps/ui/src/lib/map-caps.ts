/**
 * Zoom-band marker caps for the bbox (live map) path: a higher cap while
 * clustering absorbs density, a lower one once every pin renders individually.
 *
 * `useMapMarkers` uses `capForZoom` for both the fetch `limit` and the
 * truncation check (`meta.total > cap`), so the two cannot disagree.
 *
 * All three knobs are read through `getRuntimeEnv` at module load (`config.js`
 * loads before the bundle), so they are retunable per deployment without a
 * rebuild:
 *   - `VITE_MAP_MARKER_CAP_CLUSTERED` (default 1000)
 *   - `VITE_MAP_MARKER_CAP_INDIVIDUAL` (default 500)
 *   - `VITE_MAP_CLUSTER_DISABLE_ZOOM` (default `DEFAULT_CLUSTER_DISABLE_ZOOM`, 14)
 */
import { zoomBand, DEFAULT_CLUSTER_DISABLE_ZOOM } from './map-viewport-snap';
import { getRuntimeEnv } from './runtime-env';

const DEFAULT_CLUSTERED_MARKER_CAP = 1000;
const DEFAULT_INDIVIDUAL_MARKER_CAP = 500;

function readPositiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/** Reads `VITE_MAP_MARKER_CAP_CLUSTERED`, falling back to 1000. Exported for tests. */
export function resolveClusteredMarkerCap(): number {
  return readPositiveIntEnv(getRuntimeEnv('VITE_MAP_MARKER_CAP_CLUSTERED'), DEFAULT_CLUSTERED_MARKER_CAP);
}

/** Reads `VITE_MAP_MARKER_CAP_INDIVIDUAL`, falling back to 500. Exported for tests. */
export function resolveIndividualMarkerCap(): number {
  return readPositiveIntEnv(getRuntimeEnv('VITE_MAP_MARKER_CAP_INDIVIDUAL'), DEFAULT_INDIVIDUAL_MARKER_CAP);
}

/** Reads `VITE_MAP_CLUSTER_DISABLE_ZOOM`, falling back to 14. Exported for tests. */
export function resolveClusterDisableZoomEnv(): number {
  return readPositiveIntEnv(getRuntimeEnv('VITE_MAP_CLUSTER_DISABLE_ZOOM'), DEFAULT_CLUSTER_DISABLE_ZOOM);
}

// Resolved once at module load; runtime config does not change after boot.
export const CLUSTERED_MARKER_CAP = resolveClusteredMarkerCap();
export const INDIVIDUAL_MARKER_CAP = resolveIndividualMarkerCap();
export const CLUSTER_DISABLE_ZOOM = resolveClusterDisableZoomEnv();

export interface CapForZoomOptions {
  clusterDisableZoom?: number;
  clusteredCap?: number;
  individualCap?: number;
}

/**
 * The zoom floor for offering "Search this area".
 *
 * Set to street level (15): at city zoom the rectangle is not an "area" a user
 * recognises, and 15 sits just above `DEFAULT_CLUSTER_DISABLE_ZOOM` (14), so
 * individual pins are visible when the button shows. The floor alone is not
 * the gate: the caller also requires that searching would change something
 * (the map is truncated, or matching items exist outside the view). Gating on
 * `truncated` alone needed 500+ markers in one viewport, so small networks
 * never saw the button.
 */
export const SEARCH_AREA_MIN_ZOOM = 15;

/**
 * The active marker cap for a zoom level: `individualCap` at/above the
 * cluster-disable zoom, `clusteredCap` below it. Defaults to the env-resolved
 * constants; every knob is overridable per call.
 */
export function capForZoom(zoom: number, options?: CapForZoomOptions): number {
  const clusterDisableZoom = options?.clusterDisableZoom ?? CLUSTER_DISABLE_ZOOM;
  const clusteredCap = options?.clusteredCap ?? CLUSTERED_MARKER_CAP;
  const individualCap = options?.individualCap ?? INDIVIDUAL_MARKER_CAP;
  return zoomBand(zoom, clusterDisableZoom) === 'individual' ? individualCap : clusteredCap;
}
