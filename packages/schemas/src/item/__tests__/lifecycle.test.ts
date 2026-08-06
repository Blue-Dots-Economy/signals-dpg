import { describe, expect, it } from 'vitest';
import { ItemLifecycleBody, ItemLifecycleResponse } from '../lifecycle';

const ITEM_ID = '3f0c7f6e-1b8a-4a52-9c1d-2f9b6a2c4d10';

describe('ItemLifecycleBody', () => {
  it.each(['pause', 'unpause', 'retire'])('accepts the %s action', (action) => {
    const result = ItemLifecycleBody.safeParse({ item_id: ITEM_ID, action });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ item_id: ITEM_ID, action });
    }
  });

  it('rejects a lifecycle STATUS used as an action (e.g. "live")', () => {
    const result = ItemLifecycleBody.safeParse({ item_id: ITEM_ID, action: 'live' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['action']);
    }
  });

  it('rejects an unsupported action', () => {
    expect(ItemLifecycleBody.safeParse({ item_id: ITEM_ID, action: 'delete' }).success).toBe(false);
  });

  it('is case-sensitive about the action', () => {
    expect(ItemLifecycleBody.safeParse({ item_id: ITEM_ID, action: 'Pause' }).success).toBe(false);
  });

  it('rejects a missing action', () => {
    expect(ItemLifecycleBody.safeParse({ item_id: ITEM_ID }).success).toBe(false);
  });

  it('rejects a non-uuid item_id', () => {
    const result = ItemLifecycleBody.safeParse({ item_id: 'item-1', action: 'pause' });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['item_id']);
    }
  });

  it('rejects a missing item_id', () => {
    expect(ItemLifecycleBody.safeParse({ action: 'pause' }).success).toBe(false);
  });

  it('strips unknown keys instead of failing', () => {
    const result = ItemLifecycleBody.safeParse({
      item_id: ITEM_ID,
      action: 'retire',
      reason: 'user asked',
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ item_id: ITEM_ID, action: 'retire' });
      expect(result.data).not.toHaveProperty('reason');
    }
  });
});

describe('ItemLifecycleResponse', () => {
  it.each(['draft', 'live', 'paused', 'retired'])('accepts lifecycle_status %s', (status) => {
    expect(
      ItemLifecycleResponse.safeParse({ item_id: ITEM_ID, lifecycle_status: status }).success,
    ).toBe(true);
  });

  it('rejects a status outside the draft/live/paused/retired ladder', () => {
    expect(
      ItemLifecycleResponse.safeParse({ item_id: ITEM_ID, lifecycle_status: 'archived' }).success,
    ).toBe(false);
  });

  it('rejects an ACTION returned in the status slot', () => {
    expect(
      ItemLifecycleResponse.safeParse({ item_id: ITEM_ID, lifecycle_status: 'pause' }).success,
    ).toBe(false);
  });

  it('rejects a missing lifecycle_status', () => {
    expect(ItemLifecycleResponse.safeParse({ item_id: ITEM_ID }).success).toBe(false);
  });

  it('rejects a non-uuid item_id', () => {
    expect(
      ItemLifecycleResponse.safeParse({ item_id: 'nope', lifecycle_status: 'live' }).success,
    ).toBe(false);
  });
});
