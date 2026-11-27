import * as React from 'react';
import { useMap } from 'react-leaflet';
import type { MapMarker } from '@/engine/types';

interface FitBoundsProps {
  markers: MapMarker[];
  /** Skip fitting, because the caller drives the viewport. */
  skip?: boolean;
}

export function FitBounds({ markers, skip = false }: FitBoundsProps) {
  const map = useMap();

  React.useEffect(() => {
    if (skip || markers.length === 0) return;

    // `markers` identity changes only with new data, not on pan/zoom, so this
    // does not fight the user.
    const bounds = markers.map((m) => [m.lat, m.lng] as [number, number]);
    if (bounds.length === 1) {
      map.setView(bounds[0], 10);
    } else {
      map.fitBounds(bounds, { padding: [50, 50] });
    }
  }, [skip, markers, map]);

  return null;
}
