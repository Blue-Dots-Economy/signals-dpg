import { describe, it, expect } from 'vitest';

import { itemLifecycleCaseId } from '../notify_item_lifecycle';

/**
 * Case-id resolution for item-lifecycle emails (#531/#534). Pure mapping —
 * seeker→profile, provider/service_provider→offer, and an aggregator
 * acting-org on create routes to the initiation email instead of the self
 * create email (so aggregator-onboarded records get one email, not two).
 */
describe('itemLifecycleCaseId', () => {
  it('maps seeker → profile.* per op', () => {
    const base = { ownerId: 'u1', domain: 'seeker', network: 'blue_dot' } as const;
    expect(itemLifecycleCaseId({ ...base, op: 'create' })).toBe('profile.create');
    expect(itemLifecycleCaseId({ ...base, op: 'update' })).toBe('profile.update');
    expect(itemLifecycleCaseId({ ...base, op: 'pause' })).toBe('profile.pause');
    expect(itemLifecycleCaseId({ ...base, op: 'retire' })).toBe('profile.retire');
  });

  it('maps provider + service_provider → offer.*', () => {
    for (const domain of ['provider', 'service_provider']) {
      expect(itemLifecycleCaseId({ ownerId: 'u1', domain, network: 'blue_dot', op: 'create' })).toBe(
        'offer.create',
      );
      expect(itemLifecycleCaseId({ ownerId: 'u1', domain, network: 'blue_dot', op: 'update' })).toBe(
        'offer.update',
      );
    }
  });

  it('routes an aggregator create to the initiation email', () => {
    expect(
      itemLifecycleCaseId({
        ownerId: 'u1',
        domain: 'seeker',
        network: 'blue_dot',
        op: 'create',
        actingOrgType: 'aggregator',
      }),
    ).toBe('account.aggregator_init');
  });

  it('does NOT re-route non-create ops even under an aggregator acting-org', () => {
    expect(
      itemLifecycleCaseId({
        ownerId: 'u1',
        domain: 'seeker',
        network: 'blue_dot',
        op: 'update',
        actingOrgType: 'aggregator',
      }),
    ).toBe('profile.update');
  });
});
