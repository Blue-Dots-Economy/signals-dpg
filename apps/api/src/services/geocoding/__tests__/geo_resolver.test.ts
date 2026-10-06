import { describe, it, expect, vi } from 'vitest';
vi.mock('@api/db/secondary/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@/config', () => ({
  geocodingConfig: { cache_ttl_seconds: 2592000, cache_negative_ttl_seconds: 3600 },
}));

import {
  parsePhotonFeatures,
  parseGoogleGeocode,
  pickGoogleResult,
  buildGoogleGeocodeUrl,
  pickPhotonFeature,
  buildPhotonUrl,
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

describe('pickGoogleResult (#785)', () => {
  const result = (
    lat: number,
    lng: number,
    country: string,
    types: string[] = ['locality', 'political'],
  ) => ({
    geometry: { location: { lat, lng } },
    types,
    address_components: [
      { short_name: 'X', long_name: 'X', types: ['locality', 'political'] },
      { short_name: country, long_name: country, types: ['country', 'political'] },
    ],
  });

  it('with no country set, returns the first result (historical behaviour)', () => {
    const json = { status: 'OK', results: [result(23.8, 90.4, 'BD'), result(15.4, 75.0, 'IN')] };
    expect(pickGoogleResult(json)).toEqual({ lat: 23.8, lng: 90.4 });
  });

  it('skips a result in another country and returns the first in-country one', () => {
    const json = { status: 'OK', results: [result(23.8, 90.4, 'BD'), result(15.4, 75.0, 'IN')] };
    expect(pickGoogleResult(json, 'IN')).toEqual({ lat: 15.4, lng: 75.0 });
  });

  it('rejects a coarse country-level fallback as not found', () => {
    const json = {
      status: 'OK',
      results: [{ ...result(22.0, 79.0, 'IN', ['country', 'political']), partial_match: true }],
    };
    expect(pickGoogleResult(json, 'IN')).toBeNull();
  });

  it('rejects a state-level fallback as not found', () => {
    const json = {
      status: 'OK',
      results: [result(15.3, 75.7, 'IN', ['administrative_area_level_1', 'political'])],
    };
    expect(pickGoogleResult(json, 'IN')).toBeNull();
  });

  it('keeps a partial match that still resolves to a district or town', () => {
    const json = {
      status: 'OK',
      results: [
        {
          ...result(15.46, 75.01, 'IN', ['administrative_area_level_3', 'political']),
          partial_match: true,
        },
      ],
    };
    expect(pickGoogleResult(json, 'IN')).toEqual({ lat: 15.46, lng: 75.01 });
  });

  it('returns null when every result is foreign', () => {
    const json = { status: 'OK', results: [result(23.8, 90.4, 'BD')] };
    expect(pickGoogleResult(json, 'IN')).toBeNull();
  });

  it('returns null on a non-OK status', () => {
    expect(pickGoogleResult({ status: 'ZERO_RESULTS', results: [] }, 'IN')).toBeNull();
  });
});

describe('buildGoogleGeocodeUrl (#785)', () => {
  it('adds a components=country filter when a country is set', () => {
    const url = buildGoogleGeocodeUrl('Dharwad', 'k', 'IN');
    expect(url.searchParams.get('components')).toBe('country:IN');
    expect(url.searchParams.get('address')).toBe('Dharwad');
  });

  it('sends no components param when no country is set', () => {
    const url = buildGoogleGeocodeUrl('Dharwad', 'k');
    expect(url.searchParams.has('components')).toBe(false);
  });
});

describe('pickPhotonFeature (#788)', () => {
  const feature = (lng: number, lat: number, countrycode: string, type = 'city') => ({
    geometry: { coordinates: [lng, lat] },
    properties: { countrycode, type },
  });

  it('with no country set, returns the first feature (historical behaviour)', () => {
    const json = { features: [feature(90.4, 23.8, 'BD'), feature(75.0, 15.4, 'IN')] };
    expect(pickPhotonFeature(json)).toEqual({ lat: 23.8, lng: 90.4 });
  });

  it('skips a feature in another country and returns the first in-country one', () => {
    const json = { features: [feature(90.4, 23.8, 'BD'), feature(75.0, 15.4, 'in')] };
    expect(pickPhotonFeature(json, 'IN')).toEqual({ lat: 15.4, lng: 75.0 });
  });

  it('rejects a country- or state-level feature as not found', () => {
    const json = {
      features: [feature(79.0, 22.0, 'IN', 'country'), feature(75.7, 15.3, 'IN', 'state')],
    };
    expect(pickPhotonFeature(json, 'IN')).toBeNull();
  });

  it('returns null when every feature is foreign', () => {
    expect(pickPhotonFeature({ features: [feature(90.4, 23.8, 'BD')] }, 'IN')).toBeNull();
  });
});

describe('buildPhotonUrl (#788)', () => {
  it('adds countrycode and asks for several results when a country is set', () => {
    const url = new URL(buildPhotonUrl('Dharwad', 'https://photon.example/', 'IN'));
    expect(url.pathname).toBe('/api');
    expect(url.searchParams.get('q')).toBe('Dharwad');
    expect(url.searchParams.get('countrycode')).toBe('IN');
    expect(url.searchParams.get('limit')).toBe('5');
  });

  it('keeps the single-result request with no countrycode when no country is set', () => {
    const url = new URL(buildPhotonUrl('Dharwad', 'https://photon.example'));
    expect(url.searchParams.has('countrycode')).toBe(false);
    expect(url.searchParams.get('limit')).toBe('1');
  });
});
