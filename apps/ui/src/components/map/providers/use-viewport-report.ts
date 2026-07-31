import * as React from 'react';
import { haversineMeters } from '@/lib/geo/distance';
import type { LatLng } from '@/lib/geo/types';
import type { MapViewport } from '@/engine/types';

/** Debounce window for viewport emission, matched to the task brief (~300ms). */
const VIEWPORT_DEBOUNCE_MS = 300;

/** The two opposite corners of `map.getBounds()`, as reported by either provider. */
export interface ViewportBoundsCorners {
  sw: LatLng;
  ne: LatLng;
}

/**
 * Converts a center + the current bounds into the `MapViewport` shape:
 * center + half-diagonal radius (unchanged, #203 §5.2) PLUS the raw bbox
 * corners (#203 map-serverside-search Task 4) so callers can send a
 * server-side bbox query instead of a client-computed radius. `zoom` (#203
 * §7) is threaded straight through from the caller's `map.getZoom()` and is
 * optional — omitted entirely (rather than emitted as `undefined`) when the
 * caller doesn't have one, so a plain `JSON.stringify` / query-key spread of
 * the resulting viewport never carries a spurious `zoom: undefined` key.
 */
function toViewport(center: LatLng, bounds: ViewportBoundsCorners, zoom?: number): MapViewport {
  return {
    lat: center.lat,
    lng: center.lng,
    radiusMeters: haversineMeters(center, bounds.ne),
    minLat: bounds.sw.lat,
    minLng: bounds.sw.lng,
    maxLat: bounds.ne.lat,
    maxLng: bounds.ne.lng,
    ...(zoom !== undefined ? { zoom } : {}),
  };
}

/**
 * Returns two stable functions each map provider uses to report its viewport:
 *
 * - `emit` — called on the native moveend/idle event with the current center,
 *   the current bounds corners (SW + NE, from `map.getBounds()`), and the
 *   current zoom level (#203 §7). Debounces (~300ms) and computes both the
 *   half-diagonal radius (great-circle distance from `center` to the NE
 *   corner, via the shared haversine helper) and the raw bbox corners before
 *   calling `onViewportChange`.
 * - `emitNow` — same shape, but bypasses the debounce and fires immediately.
 *   Used once, on mount, so a provider whose only post-mount native event is
 *   gated behind user interaction (e.g. Leaflet's `moveend`, which does not
 *   refire on its own after the initial construction-time firing) still
 *   reports an initial viewport, instead of leaving `useMapMarkers` disabled
 *   forever.
 *
 * A no-op `onViewportChange` (the tourist app never passes one) makes both
 * returned functions no-ops too — providers can wire the native event
 * listener unconditionally without extra branching, though in practice both
 * providers skip attaching the listener (and calling `emitNow`) entirely when
 * the prop is absent.
 *
 * Pending timers are cleared on unmount so a debounced emission never fires
 * after the owning provider component (and its map instance) is gone.
 */
export function useViewportReportEmitter(
  onViewportChange: ((viewport: MapViewport) => void) | undefined
): {
  emit: (center: LatLng, bounds: ViewportBoundsCorners, zoom?: number) => void;
  emitNow: (center: LatLng, bounds: ViewportBoundsCorners, zoom?: number) => void;
} {
  const callbackRef = React.useRef(onViewportChange);
  callbackRef.current = onViewportChange;

  const timeoutRef = React.useRef<number | undefined>(undefined);

  React.useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  const emit = React.useCallback((center: LatLng, bounds: ViewportBoundsCorners, zoom?: number) => {
    if (!callbackRef.current) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      callbackRef.current?.(toViewport(center, bounds, zoom));
    }, VIEWPORT_DEBOUNCE_MS);
  }, []);

  const emitNow = React.useCallback((center: LatLng, bounds: ViewportBoundsCorners, zoom?: number) => {
    if (!callbackRef.current) return;
    window.clearTimeout(timeoutRef.current);
    callbackRef.current(toViewport(center, bounds, zoom));
  }, []);

  return { emit, emitNow };
}
