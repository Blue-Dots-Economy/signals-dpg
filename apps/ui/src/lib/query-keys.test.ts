import { describe, it, expect } from 'vitest';
import { queryKeys } from './query-keys';

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
});
