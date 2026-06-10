import { describe, it, expect } from 'vitest';
import { primaryLocation } from '../item_service';

describe('primaryLocation', () => {
  it('returns the first entry', () => {
    expect(primaryLocation([{ lat: 1, lng: 2, label: 'A' }, { lat: 3, lng: 4 }]))
      .toEqual({ lat: 1, lng: 2, label: 'A' });
  });
  it('returns null for empty/undefined', () => {
    expect(primaryLocation([])).toBeNull();
    expect(primaryLocation(undefined)).toBeNull();
  });
});
