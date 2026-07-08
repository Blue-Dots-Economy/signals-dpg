import { describe, it, expect } from 'vitest';
import { sameLocations } from '../item_service';

describe('sameLocations', () => {
  it('true for identical coord arrays', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [{ lat: 1, lng: 2 }])).toBe(true);
  });
  it('true when labels match', () => {
    expect(
      sameLocations([{ lat: 1, lng: 2, label: 'x' }], [{ lat: 1, lng: 2, label: 'x' }]),
    ).toBe(true);
  });
  it('false on differing coord', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [{ lat: 1, lng: 3 }])).toBe(false);
  });
  it('false on differing length', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [])).toBe(false);
  });
  it('false on differing label', () => {
    expect(
      sameLocations([{ lat: 1, lng: 2, label: 'x' }], [{ lat: 1, lng: 2, label: 'y' }]),
    ).toBe(false);
  });
});
