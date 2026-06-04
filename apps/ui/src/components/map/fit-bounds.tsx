import * as React from 'react';
import { useMap } from 'react-leaflet';
import type { MapMarker } from '@/engine/types';

interface FitBoundsProps {
  markers: MapMarker[];
  /**
   * When true the component skips fitting bounds because the caller has
   * already set an explicit initial viewport (e.g. centred on the user's own
   * profile). Defaults to false, preserving the original "fit everything"
   * behaviour.
   */
  skip?: boolean;
}

export function FitBounds({ markers, skip = false }: FitBoundsProps) {
  const map = useMap();

  React.useEffect(() => {
    // When skip is true a specific profile viewport is active — do nothing and
    // let the SetView component (or Google MapView equivalent) drive the camera.
    if (skip || markers.length === 0) return;

    // Fit to all current markers. The effect re-runs whenever skip transitions
    // false (returning from a profile view to "All items") or markers change
    // (new data arrives). markers identity only changes when the data changes,
    // not on pan/zoom, so this does not fight normal user interaction.
    const bounds = markers.map((m) => [m.lat, m.lng] as [number, number]);
    if (bounds.length === 1) {
      map.setView(bounds[0], 10);
    } else {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [skip, markers, map]);

  return null;
}
