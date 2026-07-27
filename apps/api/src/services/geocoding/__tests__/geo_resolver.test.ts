import { describe, it, expect, vi } from 'vitest';
vi.mock('@api/db/secondary/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@/config', () => ({
  geocodingConfig: { cache_ttl_seconds: 2592000, cache_negative_ttl_seconds: 3600 },
}));

import { parsePhotonFeatures, parseGoogleGeocode } from '../geo_resolver';

describe('parsePhotonFeatures', () => {
  it('returns lat/lng from the first feature ([lng,lat] order)', () => {
    const json = { features: [{ geometry: { coordinates: [77.59, 12.97] } }] };
    expect(parsePhotonFeatures(json)).toEqual({ lat: 12.97, lng: 77.59 });
  });
  it('returns null when no features', () => {
    expect(parsePhotonFeatures({ features: [] })).toBeNull();
  });
});

describe('parseGoogleGeocode', () => {
  it('returns lat/lng from the first result geometry', () => {
    const json = {
      status: 'OK',
      results: [{ geometry: { location: { lat: 12.97, lng: 77.59 } } }],
    };
    expect(parseGoogleGeocode(json)).toEqual({ lat: 12.97, lng: 77.59 });
  });
  it('returns null on ZERO_RESULTS', () => {
    expect(parseGoogleGeocode({ status: 'ZERO_RESULTS', results: [] })).toBeNull();
  });
});
