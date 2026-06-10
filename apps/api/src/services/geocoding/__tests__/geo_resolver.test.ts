import { describe, it, expect } from 'vitest';
import {
  parsePhotonFeatures,
  parseGoogleGeocode,
  parseGoogleGeocodeDetailed,
  parsePhotonFeaturesDetailed,
} from '../geo_resolver';

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

describe('parseGoogleGeocodeDetailed', () => {
  it('extracts coords + city (locality) / state / country', () => {
    const json = {
      status: 'OK',
      results: [
        {
          geometry: { location: { lat: 12.91, lng: 77.64 } },
          address_components: [
            { long_name: 'HSR Layout', types: ['sublocality'] },
            { long_name: 'Bengaluru', types: ['locality'] },
            { long_name: 'Karnataka', types: ['administrative_area_level_1'] },
            { long_name: 'India', types: ['country'] },
          ],
        },
      ],
    };
    expect(parseGoogleGeocodeDetailed(json)).toEqual({
      lat: 12.91,
      lng: 77.64,
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India',
    });
  });

  it('falls back to the district (admin_area_level_2) when there is no locality', () => {
    const json = {
      status: 'OK',
      results: [
        {
          geometry: { location: { lat: 13.33, lng: 77.11 } },
          address_components: [
            { long_name: 'Tumakuru', types: ['administrative_area_level_2'] },
            { long_name: 'Karnataka', types: ['administrative_area_level_1'] },
            { long_name: 'India', types: ['country'] },
          ],
        },
      ],
    };
    expect(parseGoogleGeocodeDetailed(json)?.city).toBe('Tumakuru');
  });

  it('returns null on ZERO_RESULTS', () => {
    expect(parseGoogleGeocodeDetailed({ status: 'ZERO_RESULTS', results: [] })).toBeNull();
  });
});

describe('parsePhotonFeaturesDetailed', () => {
  it('extracts coords + city / state / country from properties', () => {
    const json = {
      features: [
        {
          geometry: { coordinates: [77.64, 12.91] },
          properties: { city: 'Bengaluru', state: 'Karnataka', country: 'India' },
        },
      ],
    };
    expect(parsePhotonFeaturesDetailed(json)).toEqual({
      lat: 12.91,
      lng: 77.64,
      city: 'Bengaluru',
      state: 'Karnataka',
      country: 'India',
    });
  });

  it('falls back to district/county when city is absent', () => {
    const json = {
      features: [
        {
          geometry: { coordinates: [77.11, 13.33] },
          properties: { county: 'Tumakuru', state: 'Karnataka', country: 'India' },
        },
      ],
    };
    expect(parsePhotonFeaturesDetailed(json)?.city).toBe('Tumakuru');
  });

  it('returns null when there are no features', () => {
    expect(parsePhotonFeaturesDetailed({ features: [] })).toBeNull();
  });
});
