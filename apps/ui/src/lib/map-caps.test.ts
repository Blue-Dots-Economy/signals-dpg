import { describe, it, expect, afterEach } from 'vitest';
import {
  capForZoom,
  resolveClusteredMarkerCap,
  resolveIndividualMarkerCap,
  resolveClusterDisableZoomEnv,
} from './map-caps';
import { DEFAULT_CLUSTER_DISABLE_ZOOM } from './map-viewport-snap';

describe('capForZoom', () => {
  it('returns the clustered cap (1000) below the cluster-disable zoom', () => {
    expect(capForZoom(DEFAULT_CLUSTER_DISABLE_ZOOM - 1)).toBe(1000);
    expect(capForZoom(0)).toBe(1000);
  });

  it('returns the individual cap (500) at/above the cluster-disable zoom', () => {
    expect(capForZoom(DEFAULT_CLUSTER_DISABLE_ZOOM)).toBe(500);
    expect(capForZoom(DEFAULT_CLUSTER_DISABLE_ZOOM + 4)).toBe(500);
  });

  it('honors an explicit cluster-disable-zoom override', () => {
    expect(capForZoom(9, { clusterDisableZoom: 10 })).toBe(1000);
    expect(capForZoom(10, { clusterDisableZoom: 10 })).toBe(500);
  });

  it('honors explicit cap overrides', () => {
    expect(capForZoom(0, { clusteredCap: 2000 })).toBe(2000);
    expect(capForZoom(20, { individualCap: 250 })).toBe(250);
  });
});

describe('env overrides (#203 Task 6: VITE_MAP_MARKER_CAP_CLUSTERED / _INDIVIDUAL / VITE_MAP_CLUSTER_DISABLE_ZOOM)', () => {
  const keys = [
    'VITE_MAP_MARKER_CAP_CLUSTERED',
    'VITE_MAP_MARKER_CAP_INDIVIDUAL',
    'VITE_MAP_CLUSTER_DISABLE_ZOOM',
  ] as const;
  const originals = Object.fromEntries(keys.map((k) => [k, import.meta.env[k]]));

  afterEach(() => {
    for (const k of keys) {
      if (originals[k] === undefined) {
        delete (import.meta.env as unknown as Record<string, string | undefined>)[k];
      } else {
        (import.meta.env as unknown as Record<string, string | undefined>)[k] = originals[k];
      }
    }
  });

  it('resolveClusteredMarkerCap reads VITE_MAP_MARKER_CAP_CLUSTERED, falling back to 1000', () => {
    expect(resolveClusteredMarkerCap()).toBe(1000);
    (import.meta.env as unknown as Record<string, string>).VITE_MAP_MARKER_CAP_CLUSTERED = '2500';
    expect(resolveClusteredMarkerCap()).toBe(2500);
  });

  it('resolveIndividualMarkerCap reads VITE_MAP_MARKER_CAP_INDIVIDUAL, falling back to 500', () => {
    expect(resolveIndividualMarkerCap()).toBe(500);
    (import.meta.env as unknown as Record<string, string>).VITE_MAP_MARKER_CAP_INDIVIDUAL = '750';
    expect(resolveIndividualMarkerCap()).toBe(750);
  });

  it('resolveClusterDisableZoomEnv reads VITE_MAP_CLUSTER_DISABLE_ZOOM, falling back to 14', () => {
    expect(resolveClusterDisableZoomEnv()).toBe(14);
    (import.meta.env as unknown as Record<string, string>).VITE_MAP_CLUSTER_DISABLE_ZOOM = '16';
    expect(resolveClusterDisableZoomEnv()).toBe(16);
  });

  it('ignores an invalid/empty/non-positive override and falls back to the default', () => {
    const env = import.meta.env as unknown as Record<string, string>;
    env.VITE_MAP_MARKER_CAP_CLUSTERED = '';
    expect(resolveClusteredMarkerCap()).toBe(1000);
    env.VITE_MAP_MARKER_CAP_CLUSTERED = 'not-a-number';
    expect(resolveClusteredMarkerCap()).toBe(1000);
    env.VITE_MAP_MARKER_CAP_CLUSTERED = '-5';
    expect(resolveClusteredMarkerCap()).toBe(1000);
  });
});
