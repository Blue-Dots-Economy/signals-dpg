import * as React from 'react';
import type { MapMarker } from '@/engine/types';
import { buildClusterIndex, queryClusters, resolveClusterRadiusPx } from './map-clusters';
import type { ClusterView, MapClusterItem } from './map-clusters';

/** The bubbles and points to draw for `view`; the index is rebuilt only when `markers` or the radius changes. */
export function useMapClusters(
  markers: MapMarker[],
  view: ClusterView | null,
  options: { maxZoom: number },
): MapClusterItem[] {
  const { maxZoom } = options;
  const radiusPx = resolveClusterRadiusPx();
  const index = React.useMemo(
    () => buildClusterIndex(markers, { maxZoom, radiusPx }),
    [markers, maxZoom, radiusPx],
  );
  return React.useMemo(() => (view ? queryClusters(index, view) : []), [index, view]);
}
