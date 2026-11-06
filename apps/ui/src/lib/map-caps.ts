/**
 * The most map markers fetched per domain for one view on the bbox (live map)
 * path, at every zoom. Read through `getRuntimeEnv` at module load (`config.js`
 * loads before the bundle), so it is retunable per deployment without a
 * rebuild: `VITE_MAP_MARKER_CAP` (default 10000).
 */
import { getRuntimeEnv } from './runtime-env';

const DEFAULT_MARKER_CAP = 10000;

/** Reads `VITE_MAP_MARKER_CAP`: a positive whole number, else 10000. Exported for tests. */
export function resolveMarkerCap(): number {
  const n = Number(getRuntimeEnv('VITE_MAP_MARKER_CAP') || Number.NaN);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MARKER_CAP;
}

// Resolved once at module load; runtime config does not change after boot.
export const MARKER_CAP = resolveMarkerCap();

/**
 * The zoom floor for offering "List what's in this view".
 *
 * Set to street level (15): at city zoom the rectangle is not an "area" a user
 * recognises. The floor alone is not the gate: the caller also requires that
 * searching would change something (the map is truncated, or matching items
 * exist outside the view). Gating on `truncated` alone needed 500+ markers in
 * one viewport, so small networks never saw the button.
 */
export const SEARCH_AREA_MIN_ZOOM = 15;
