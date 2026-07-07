import { describe, it, expect } from 'vitest';
import { jitterPrivateLocations } from '../item_service';
import { jitterCoordinate } from '../geocoding/jitter';
import { geocodingConfig } from '@/config';

const privateSingle = {
  properties: { address: { type: 'string', location: 'primary', private: true } },
};
const publicSingle = {
  properties: { area: { type: 'string', location: 'primary' } },
};
const min = geocodingConfig.jitter_min_meters;
const max = geocodingConfig.jitter_max_meters;

describe('jitterPrivateLocations', () => {
  it('jitters a private primary location (matches jitterCoordinate)', () => {
    const locs = [{ lat: 12.9716, lng: 77.5946 }];
    expect(jitterPrivateLocations(locs, privateSingle)).toEqual([
      jitterCoordinate(locs[0], min, max),
    ]);
  });

  it('leaves a public location unchanged', () => {
    const locs = [{ lat: 12.9716, lng: 77.5946 }];
    expect(jitterPrivateLocations(locs, publicSingle)).toEqual(locs);
  });

  it('preserves label while jittering', () => {
    const locs = [{ lat: 12.9716, lng: 77.5946, label: 'Home' }];
    expect(jitterPrivateLocations(locs, privateSingle)[0].label).toBe('Home');
  });

  it('is a no-op for empty / no-schema / no-primary', () => {
    const locs = [{ lat: 1, lng: 2 }];
    expect(jitterPrivateLocations([], privateSingle)).toEqual([]);
    expect(jitterPrivateLocations(locs, { properties: {} })).toEqual(locs);
    expect(jitterPrivateLocations(locs, null)).toEqual(locs);
    expect(jitterPrivateLocations(locs, undefined)).toEqual(locs);
  });
});
