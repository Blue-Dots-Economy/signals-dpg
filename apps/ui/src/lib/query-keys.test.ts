import { describe, it, expect } from 'vitest';
import { queryKeys } from './query-keys';
import { snapViewportForKey } from './map-viewport-snap';

describe('queryKeys', () => {
  it('preserves the existing network-config key value', () => {
    expect(queryKeys.networkConfig('blue_dot')).toEqual(['network-config', 'blue_dot']);
  });

  it('preserves the existing consent-config key value (brand may be null)', () => {
    expect(queryKeys.consentConfig('blue_dot', 'onetac')).toEqual(['consent-config', 'blue_dot', 'onetac']);
    expect(queryKeys.consentConfig('blue_dot', null)).toEqual(['consent-config', 'blue_dot', null]);
  });

  it('roots action keys at ["actions"] with the same shape as before', () => {
    expect(queryKeys.actions.all).toEqual(['actions']);
    expect(queryKeys.actions.pendingCount()).toEqual(['actions', 'pendingCount']);
    expect(queryKeys.actions.detail('abc')).toEqual(['actions', 'detail', 'abc']);
  });

  it('defines browse/my-items/markers keys for later phases', () => {
    expect(queryKeys.myItems('blue_dot')).toEqual(['my-items', 'blue_dot']);
    const f = { limit: 50, offset: 0 };
    expect(queryKeys.browseItems('blue_dot', 'seeker', f)).toEqual(['browse-items', 'blue_dot', 'seeker', f]);
    expect(queryKeys.markers('blue_dot', 'seeker', f)).toEqual(['markers', 'blue_dot', 'seeker', f]);
  });

  it('defines the profile-form keys (2b-iii)', () => {
    expect(queryKeys.networkConfigs()).toEqual(['network-configs']);
    expect(queryKeys.resolvedNetwork('blue_dot', 'https://api.example')).toEqual([
      'resolved-network',
      'blue_dot',
      'https://api.example',
    ]);
    expect(queryKeys.editItem('blue_dot', 'item-123')).toEqual(['edit-item', 'blue_dot', 'item-123']);
  });

  it('defines the profile-consent key', () => {
    expect(queryKeys.profileConsent('blue_dot')).toEqual(['profile-consent', 'blue_dot']);
  });

  it('defines the item-detail key (#203 P4 Task 3)', () => {
    expect(queryKeys.itemDetail('blue_dot', 'item-123')).toEqual(['item-detail', 'blue_dot', 'item-123']);
  });

  describe('markers key with snapped bbox + zoom band + filters (#203 map-serverside-search Task 4)', () => {
    const bbox = { minLat: 19.0, minLng: 72.0, maxLat: 19.5, maxLng: 72.5 };
    const buildFilters = (
      viewport: Parameters<typeof snapViewportForKey>[0],
      filters: Record<string, unknown>,
    ) => {
      const snapped = snapViewportForKey(viewport);
      return { snappedBbox: snapped?.snappedBbox, zoomBand: snapped?.zoomBand, filters, limit: 500 };
    };

    it('produces an identical key for a same/contained bbox + same zoom band + same filters', () => {
      const a = queryKeys.markers(
        'blue_dot',
        'seeker',
        buildFilters({ ...bbox, zoom: 8 }, { gender: ['female'] }),
      );
      const contained = {
        minLat: bbox.minLat + 0.01,
        minLng: bbox.minLng + 0.01,
        maxLat: bbox.maxLat - 0.01,
        maxLng: bbox.maxLng - 0.01,
      };
      const b = queryKeys.markers(
        'blue_dot',
        'seeker',
        buildFilters({ ...contained, zoom: 9 }, { gender: ['female'] }),
      );
      expect(a).toEqual(b);
    });

    it('produces a different key for a pan that crosses a grid cell', () => {
      const a = queryKeys.markers('blue_dot', 'seeker', buildFilters({ ...bbox, zoom: 8 }, {}));
      const panned = {
        minLat: bbox.minLat + 0.1,
        minLng: bbox.minLng + 0.1,
        maxLat: bbox.maxLat + 0.1,
        maxLng: bbox.maxLng + 0.1,
      };
      const b = queryKeys.markers('blue_dot', 'seeker', buildFilters({ ...panned, zoom: 8 }, {}));
      expect(a).not.toEqual(b);
    });

    it('produces a different key for a zoom that crosses the cluster-disable band', () => {
      const a = queryKeys.markers('blue_dot', 'seeker', buildFilters({ ...bbox, zoom: 13 }, {}));
      const b = queryKeys.markers('blue_dot', 'seeker', buildFilters({ ...bbox, zoom: 14 }, {}));
      expect(a).not.toEqual(b);
    });

    it('produces a different key for a filter change with the same bbox and zoom band', () => {
      const a = queryKeys.markers(
        'blue_dot',
        'seeker',
        buildFilters({ ...bbox, zoom: 8 }, { gender: ['female'] }),
      );
      const b = queryKeys.markers(
        'blue_dot',
        'seeker',
        buildFilters({ ...bbox, zoom: 8 }, { gender: ['male'] }),
      );
      expect(a).not.toEqual(b);
    });
  });
});
