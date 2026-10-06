import { describe, it, expect } from 'vitest';

import { itemLifecycleEventType } from '../notify_item_lifecycle';

/**
 * Event selection for item-lifecycle notifications. Signals picks only the
 * event; the profile/offer copy for the item's domain is chosen by the NS
 * policy for (domain, event). The two choices that stay here: a draft create is
 * `item.created_draft`, and an aggregator create is
 * `item.onboarded_by_aggregator` instead of the self create.
 */
describe('itemLifecycleEventType', () => {
  const base = { ownerId: 'u1', domain: 'seeker', network: 'blue_dot' } as const;

  it('maps each op to its item event, whatever the domain', () => {
    for (const domain of ['seeker', 'provider', 'service_provider']) {
      expect(itemLifecycleEventType({ ...base, domain, op: 'create' })).toBe('item.created');
      expect(itemLifecycleEventType({ ...base, domain, op: 'update' })).toBe('item.updated');
      expect(itemLifecycleEventType({ ...base, domain, op: 'pause' })).toBe('item.paused');
      expect(itemLifecycleEventType({ ...base, domain, op: 'retire' })).toBe('item.retired');
    }
  });

  it('routes a draft create to item.created_draft, a live/absent-status create to item.created', () => {
    expect(itemLifecycleEventType({ ...base, op: 'create', lifecycleStatus: 'draft' })).toBe(
      'item.created_draft',
    );
    expect(itemLifecycleEventType({ ...base, op: 'create', lifecycleStatus: 'live' })).toBe(
      'item.created',
    );
    expect(itemLifecycleEventType({ ...base, op: 'create' })).toBe('item.created');
  });

  it('routes an aggregator create to item.onboarded_by_aggregator, ignoring lifecycle status', () => {
    expect(itemLifecycleEventType({ ...base, op: 'create', actingOrgType: 'aggregator' })).toBe(
      'item.onboarded_by_aggregator',
    );
    expect(
      itemLifecycleEventType({ ...base, op: 'create', actingOrgType: 'aggregator', lifecycleStatus: 'draft' }),
    ).toBe('item.onboarded_by_aggregator');
  });

  it('does NOT re-route non-create ops even under an aggregator acting-org', () => {
    expect(itemLifecycleEventType({ ...base, op: 'update', actingOrgType: 'aggregator' })).toBe(
      'item.updated',
    );
  });

  it('returns null for an unknown op', () => {
    expect(itemLifecycleEventType({ ...base, op: 'archive' as never })).toBeNull();
  });
});
