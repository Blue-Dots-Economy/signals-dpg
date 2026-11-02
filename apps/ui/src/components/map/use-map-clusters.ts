import * as React from 'react';
import type { MapMarker } from '@/engine/types';
import { buildClusterIndex, queryClusters } from './map-clusters';
import type { ClusterIndexOptions, ClusterView, MapClusterItem } from './map-clusters';

/** The bubbles and points to draw for `view`; the index is rebuilt only when `markers` changes. */
export function useMapClusters(
  markers: MapMarker[],
  view: ClusterView | null,
  options: ClusterIndexOptions,
): MapClusterItem[] {
  const { maxZoom } = options;
  const index = React.useMemo(() => buildClusterIndex(markers, { maxZoom }), [markers, maxZoom]);
  return React.useMemo(() => (view ? queryClusters(index, view) : []), [index, view]);
}
