import Supercluster from 'supercluster';
import type { MapMarker, OpenSpotGroup } from '@/engine/types';
import { breakdownFromCounts } from './cluster-breakdown';
import type { DomainCount } from './cluster-breakdown';

/** The map area and zoom to cluster for, in degrees. */
export interface ClusterView {
  west: number;
  south: number;
  east: number;
  north: number;
  zoom: number;
}

/** A bubble that zooming in can never split, and the area its points cover. */
export interface SpotGroup {
  /** Every point shares one coordinate, to 6 decimal places. */
  exact: boolean;
  bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number };
}

/** One thing to draw: a bubble standing for several points, or a single point. */
export type MapClusterItem =
  | {
      kind: 'cluster';
      key: string;
      lat: number;
      lng: number;
      count: number;
      breakdown: DomainCount[];
      expansionZoom: number;
      spot: SpotGroup | null;
    }
  | { kind: 'point'; key: string; marker: MapMarker };

export interface ClusterIndexOptions {
  /** The provider's maximum zoom; clustering runs up to it. */
  maxZoom: number;
}

/** Supercluster radius at its default 512 extent: 80 screen px on 256-px tiles, the same as Leaflet's clustering before. */
export const CLUSTER_RADIUS = 160;

interface PointProps {
  id: string;
  domain: string;
}

interface ClusterProps {
  counts: Record<string, number>;
}

/** Clustering index over one marker list. */
export interface MapClusterIndex {
  readonly tree: Supercluster<PointProps, ClusterProps>;
  readonly maxZoom: number;
  readonly byId: Map<string, MapMarker>;
}

/** Builds the clustering index for a marker list. */
export function buildClusterIndex(markers: MapMarker[], options: ClusterIndexOptions): MapClusterIndex {
  const tree = new Supercluster<PointProps, ClusterProps>({
    radius: CLUSTER_RADIUS,
    maxZoom: options.maxZoom,
    map: (props) => ({ counts: { [props.domain]: 1 } }),
    // Supercluster copies cluster properties shallowly, so `counts` is rebuilt rather than mutated in place.
    reduce: (acc, props) => {
      const counts = { ...acc.counts };
      for (const [domain, n] of Object.entries(props.counts)) counts[domain] = (counts[domain] ?? 0) + n;
      acc.counts = counts;
    },
  });
  tree.load(
    markers.map((m) => ({
      type: 'Feature' as const,
      geometry: { type: 'Point' as const, coordinates: [m.lng, m.lat] },
      properties: { id: m.id, domain: m.domain ?? '' },
    })),
  );
  return { tree, maxZoom: options.maxZoom, byId: new Map(markers.map((m) => [m.id, m])) };
}

/** Returns the bubbles and points inside `view` at its zoom. */
export function queryClusters(index: MapClusterIndex, view: ClusterView): MapClusterItem[] {
  const zoom = Math.min(Math.floor(view.zoom), index.maxZoom);
  const west = Math.max(-180, view.west);
  const east = Math.min(180, view.east);
  const features = index.tree.getClusters([west, view.south, east, view.north], zoom);
  const items: MapClusterItem[] = [];
  const pushPoint = (id: string) => {
    const marker = index.byId.get(id);
    if (marker) items.push({ kind: 'point', key: `p:${id}`, marker });
  };

  for (const feature of features) {
    const props = feature.properties;
    if (!('cluster' in props) || !props.cluster) {
      pushPoint((props as PointProps).id);
      continue;
    }
    const clusterId = props.cluster_id;
    const expansionZoom = index.tree.getClusterExpansionZoom(clusterId);
    const [lng, lat] = feature.geometry.coordinates;
    items.push({
      kind: 'cluster',
      key: `c:${clusterId}`,
      lat,
      lng,
      count: props.point_count,
      breakdown: breakdownFromCounts(props.counts),
      expansionZoom,
      spot: expansionZoom > index.maxZoom ? describeSpot(index, clusterId) : null,
    });
  }
  return items;
}

function describeSpot(index: MapClusterIndex, clusterId: number): SpotGroup {
  let minLat = Infinity;
  let minLng = Infinity;
  let maxLat = -Infinity;
  let maxLng = -Infinity;
  const keys = new Set<string>();
  for (const leaf of index.tree.getLeaves(clusterId, Infinity)) {
    const marker = index.byId.get(leaf.properties.id);
    if (!marker) continue;
    minLat = Math.min(minLat, marker.lat);
    minLng = Math.min(minLng, marker.lng);
    maxLat = Math.max(maxLat, marker.lat);
    maxLng = Math.max(maxLng, marker.lng);
    keys.add(`${marker.lat.toFixed(6)},${marker.lng.toFixed(6)}`);
  }
  return { exact: keys.size === 1, bounds: { minLat, minLng, maxLat, maxLng } };
}

/** The click payload for a bubble that cannot split; null for any other item. */
export function openSpotGroupOf(item: MapClusterItem): OpenSpotGroup | null {
  if (item.kind !== 'cluster' || !item.spot) return null;
  return { key: item.key, count: item.count, breakdown: item.breakdown, exact: item.spot.exact, bounds: item.spot.bounds };
}
