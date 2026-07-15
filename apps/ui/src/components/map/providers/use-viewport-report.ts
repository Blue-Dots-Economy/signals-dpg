import * as React from 'react';
import { haversineMeters } from '@/lib/geo/distance';
import type { LatLng } from '@/lib/geo/types';
import type { MapViewport } from '@/engine/types';

/** Debounce window for viewport emission, matched to the task brief (~300ms). */
const VIEWPORT_DEBOUNCE_MS = 300;

/**
 * Returns a stable function that each map provider calls on its native
 * moveend/idle event with the current center and one corner of the current
 * bounds. Debounces (~300ms) and computes the half-diagonal radius (the
 * great-circle distance from `center` to `corner`, via the shared haversine
 * helper) before calling `onViewportChange`.
 *
 * A no-op `onViewportChange` (the tourist app never passes one) makes the
 * returned function a no-op too — providers can wire the native event
 * listener unconditionally without extra branching, though in practice both
 * providers skip attaching the listener entirely when the prop is absent.
 *
 * Pending timers are cleared on unmount so a debounced emission never fires
 * after the owning provider component (and its map instance) is gone.
 */
export function useViewportReportEmitter(
  onViewportChange: ((viewport: MapViewport) => void) | undefined
): (center: LatLng, corner: LatLng) => void {
  const callbackRef = React.useRef(onViewportChange);
  callbackRef.current = onViewportChange;

  const timeoutRef = React.useRef<number | undefined>(undefined);

  React.useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current);
    },
    []
  );

  return React.useCallback((center: LatLng, corner: LatLng) => {
    if (!callbackRef.current) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      callbackRef.current?.({
        lat: center.lat,
        lng: center.lng,
        radiusMeters: haversineMeters(center, corner),
      });
    }, VIEWPORT_DEBOUNCE_MS);
  }, []);
}
