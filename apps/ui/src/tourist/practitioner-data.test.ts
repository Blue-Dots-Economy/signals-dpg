import { describe, it, expect } from 'vitest';
import { itemToCardItem, getPrimaryLocation, matchesSearch } from './practitioner-data';
import type { Item } from '@/lib/item-api';

const item: Item = {
  item_id: 'p1',
  item_network: 'orange_dot',
  item_domain: 'practitioner',
  item_type: 'profile_1.0',
  item_instance_url: null,
  item_schema_url: null,
  item_state: { name: 'Coastal Crafts', category: 'Handicraft' },
  item_locations: [{ lat: 13.34, lng: 74.74, label: 'Udupi' }],
  created_at: '',
  updated_at: '',
};

describe('itemToCardItem', () => {
  it('moves item_state into data and merges item_locations', () => {
    const card = itemToCardItem(item);
    expect(card).toEqual({
      id: 'p1',
      domain: 'practitioner',
      data: { name: 'Coastal Crafts', category: 'Handicraft', item_locations: [{ lat: 13.34, lng: 74.74, label: 'Udupi' }] },
    });
  });
});

describe('getPrimaryLocation', () => {
  it('returns the first location with its label', () => {
    expect(getPrimaryLocation(item.item_locations)).toEqual({ lat: 13.34, lng: 74.74, label: 'Udupi' });
  });
  it('returns null for an empty array', () => {
    expect(getPrimaryLocation([])).toBeNull();
  });
  it('returns null for undefined', () => {
    expect(getPrimaryLocation(undefined)).toBeNull();
  });
});

describe('matchesSearch', () => {
  it('is case-insensitive across string field values', () => {
    expect(matchesSearch({ name: 'Coastal Crafts' }, 'coastal')).toBe(true);
    expect(matchesSearch({ name: 'Coastal Crafts' }, 'xyz')).toBe(false);
  });
  it('matches empty query', () => {
    expect(matchesSearch({ name: 'X' }, '')).toBe(true);
  });
  it('matches across array-of-string field values', () => {
    expect(matchesSearch({ services: ['Tour Guide', 'Boating'] }, 'boat')).toBe(true);
  });
  it('ignores the item_locations blob', () => {
    expect(matchesSearch({ item_locations: [{ lat: 1, lng: 2 }] }, '1')).toBe(false);
  });
});
