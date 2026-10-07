import { describe, it, expect } from 'vitest';

import { itemLifecycleEventType, itemLifecycleIdempotencyKey } from '../notify_item_lifecycle';

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

/**
 * NS keeps normal-priority idempotency keys for 90 days (R12). Events that
 * repeat for the same item (update, pause) carry the UTC hour, so each hour
 * may notify once — today's behaviour under the legacy 1-hour dedupe.
 */
describe('itemLifecycleIdempotencyKey', () => {
  const HOUR = 3_600_000;
  const T = Date.UTC(2026, 9, 6, 10, 15); // 10:15 UTC
  const OWNER = '11111111-1111-4111-8111-111111111111';
  const ITEM = '22222222-2222-4222-8222-222222222222';
  const bucket = Math.floor(T / HOUR);

  it('buckets item.updated and item.paused by UTC hour', () => {
    for (const ev of ['item.updated', 'item.paused']) {
      expect(itemLifecycleIdempotencyKey(ev, OWNER, ITEM, T)).toBe(
        `item_lifecycle:${ev}:${OWNER}:${ITEM}:${bucket}`,
      );
      // Same hour → same key (deduped); next hour → a new key (sent).
      expect(itemLifecycleIdempotencyKey(ev, OWNER, ITEM, T + 40 * 60_000)).toBe(
        itemLifecycleIdempotencyKey(ev, OWNER, ITEM, T),
      );
      expect(itemLifecycleIdempotencyKey(ev, OWNER, ITEM, T + HOUR)).not.toBe(
        itemLifecycleIdempotencyKey(ev, OWNER, ITEM, T),
      );
    }
  });

  it('leaves one-shot events unbucketed', () => {
    for (const ev of ['item.created', 'item.created_draft', 'item.retired']) {
      expect(itemLifecycleIdempotencyKey(ev, OWNER, ITEM, T)).toBe(`item_lifecycle:${ev}:${OWNER}:${ITEM}`);
    }
    expect(itemLifecycleIdempotencyKey('item.onboarded_by_aggregator', OWNER, undefined, T)).toBe(
      `item_lifecycle:item.onboarded_by_aggregator:${OWNER}`,
    );
  });

  it('stays within the 128-character NS key limit in the worst case', () => {
    const farFuture = Date.UTC(9999, 11, 31, 23, 59);
    for (const ev of ['item.created', 'item.created_draft', 'item.updated', 'item.paused', 'item.retired', 'item.onboarded_by_aggregator']) {
      expect(itemLifecycleIdempotencyKey(ev, OWNER, ITEM, farFuture).length).toBeLessThanOrEqual(128);
    }
  });
});
