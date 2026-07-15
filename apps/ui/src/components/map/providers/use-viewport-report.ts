import * as React from 'react';
import { haversineMeters } from '@/lib/geo/distance';
import type { LatLng } from '@/lib/geo/types';
import type { MapViewport } from '@/engine/types';

/** Debounce window for viewport emission, matched to the task brief (~300ms). */
const VIEWPORT_DEBOUNCE_MS = 300;

/** Converts a center + one bounds corner into the `MapViewport` shape (center + half-diagonal radius). */
function toViewport(center: LatLng, corner: LatLng): MapViewport {
  return {
    lat: center.lat,
    lng: center.lng,
    radiusMeters: haversineMeters(center, corner),
  };
}

/**
 * Returns two stable functions each map provider uses to report its viewport:
 *
 * - `emit` — called on the native moveend/idle event with the current center
 *   and one corner of the current bounds. Debounces (~300ms) and computes the
 *   half-diagonal radius (the great-circle distance from `center` to
 *   `corner`, via the shared haversine helper) before calling
 *   `onViewportChange`.
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
  emit: (center: LatLng, corner: LatLng) => void;
  emitNow: (center: LatLng, corner: LatLng) => void;
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

  const emit = React.useCallback((center: LatLng, corner: LatLng) => {
    if (!callbackRef.current) return;
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      callbackRef.current?.(toViewport(center, corner));
    }, VIEWPORT_DEBOUNCE_MS);
  }, []);

  const emitNow = React.useCallback((center: LatLng, corner: LatLng) => {
    if (!callbackRef.current) return;
    window.clearTimeout(timeoutRef.current);
    callbackRef.current(toViewport(center, corner));
  }, []);

  return { emit, emitNow };
}
