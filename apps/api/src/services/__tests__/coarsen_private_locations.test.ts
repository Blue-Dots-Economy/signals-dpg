import { describe, it, expect } from 'vitest';
import { coarsenPrivateLocations } from '../item_service';

const privateSingle = {
  properties: {
    address: { type: 'string', private: true, location: 'primary' },
  },
};

const publicSingle = {
  properties: {
    address: { type: 'string', location: 'primary' },
  },
};

const publicMultiple = {
  properties: {
    service_cities: { type: 'array', location: 'primary' },
  },
};

describe('coarsenPrivateLocations', () => {
  it('rounds coordinates to ~1km grid for a private location field', () => {
    const out = coarsenPrivateLocations(
      [{ lat: 12.9121181, lng: 77.6445548 }],
      privateSingle
    );
    expect(out).toEqual([{ lat: 12.91, lng: 77.64 }]);
  });

  it('preserves the label while coarsening', () => {
    const out = coarsenPrivateLocations(
      [{ lat: 13.329621, lng: 77.1120726, label: 'Home' }],
      privateSingle
    );
    expect(out).toEqual([{ lat: 13.33, lng: 77.11, label: 'Home' }]);
  });

  it('leaves coordinates untouched for a non-private location field', () => {
    const locs = [{ lat: 12.9121181, lng: 77.6445548 }];
    expect(coarsenPrivateLocations(locs, publicSingle)).toEqual(locs);
  });

  it('leaves coordinates untouched for a public multiple field', () => {
    const locs = [
      { lat: 12.9121181, lng: 77.6445548, label: 'Bengaluru' },
      { lat: 26.846709, lng: 80.946159, label: 'Lucknow' },
    ];
    expect(coarsenPrivateLocations(locs, publicMultiple)).toEqual(locs);
  });

  it('returns an empty array unchanged', () => {
    expect(coarsenPrivateLocations([], privateSingle)).toEqual([]);
  });

  it('is a no-op when the schema has no location field', () => {
    const locs = [{ lat: 12.9121181, lng: 77.6445548 }];
    expect(coarsenPrivateLocations(locs, { properties: {} })).toEqual(locs);
  });

  it('tolerates a null/undefined schema', () => {
    const locs = [{ lat: 12.9121181, lng: 77.6445548 }];
    expect(coarsenPrivateLocations(locs, null)).toEqual(locs);
    expect(coarsenPrivateLocations(locs, undefined)).toEqual(locs);
  });
});
