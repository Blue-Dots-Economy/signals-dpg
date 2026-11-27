import * as React from 'react';
import { haversineMeters } from '@/lib/geo/distance';
import type { LatLng } from '@/lib/geo/types';
import type { MapViewport } from '@/engine/types';

const VIEWPORT_DEBOUNCE_MS = 300;

/** The two opposite corners of `map.getBounds()`, as reported by either provider. */
export interface ViewportBoundsCorners {
  sw: LatLng;
  ne: LatLng;
}

/**
 * Builds a `MapViewport`: centre, half-diagonal radius (centre to NE corner)
 * and the bbox corners. `zoom` is omitted rather than set to `undefined`, so a
 * query key built from the viewport carries no spurious `zoom` key.
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
 * Stable viewport reporters for the map providers.
 *
 * - `emit`: for the native moveend/idle event; debounced 300 ms.
 * - `emitNow`: bypasses the debounce. Called once on mount, because Leaflet's
 *   first `moveend` fires before the listener attaches and `useMapMarkers`
 *   stays disabled until it sees a viewport.
 *
 * Both are no-ops without `onViewportChange`. A pending timer is cleared on
 * unmount.
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
