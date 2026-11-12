import { describe, expect, it } from 'vitest';
import {
  googlePrecision,
  photonPrecision,
  pickGooglePlace,
  pickPhotonPlace,
} from '../geo_resolver';

const googleResult = (types: string[]) => ({
  formatted_address: 'Dharwad, Karnataka, India',
  types,
  geometry: { location: { lat: 15.46, lng: 75.0 } },
  address_components: [{ short_name: 'IN', types: ['country'] }],
});

describe('googlePrecision', () => {
  it('maps provider types to precision', () => {
    expect(googlePrecision(['postal_code'])).toBe('postal_code');
    expect(googlePrecision(['locality', 'political'])).toBe('city');
    expect(googlePrecision(['administrative_area_level_2', 'political'])).toBe('district');
    expect(googlePrecision(['administrative_area_level_3'])).toBe('district');
    expect(googlePrecision(['sublocality_level_1', 'sublocality', 'political'])).toBe('locality');
    expect(googlePrecision([])).toBe('locality');
  });
});

describe('photonPrecision', () => {
  it('maps provider types and postcode queries to precision', () => {
    expect(photonPrecision('city', 'Dharwad')).toBe('city');
    expect(photonPrecision('county', 'x')).toBe('district');
    expect(photonPrecision('street', 'x')).toBe('locality');
    expect(photonPrecision(undefined, ' 580001 ')).toBe('postal_code');
  });
});

describe('pickGooglePlace', () => {
  it('returns point, label and precision', () => {
    const json = { status: 'OK', results: [googleResult(['locality', 'political'])] };
    expect(pickGooglePlace(json, 'IN')).toEqual({
      point: { lat: 15.46, lng: 75.0 },
      label: 'Dharwad, Karnataka, India',
      precision: 'city',
    });
  });

  it('returns null for coarse-only results and ZERO_RESULTS', () => {
    expect(pickGooglePlace({ status: 'OK', results: [googleResult(['country'])] }, 'IN')).toBeNull();
    expect(pickGooglePlace({ status: 'ZERO_RESULTS', results: [] }, 'IN')).toBeNull();
  });
});

describe('pickPhotonPlace', () => {
  const feature = (type: string) => ({
    geometry: { coordinates: [75.0, 15.46] },
    properties: { name: 'Dharwad', city: 'Dharwad', state: 'Karnataka', countrycode: 'IN', type },
  });

  it('builds a deduplicated label and precision', () => {
    expect(pickPhotonPlace({ features: [feature('city')] }, 'dharwad', 'IN')).toEqual({
      point: { lat: 15.46, lng: 75.0 },
      label: 'Dharwad, Karnataka',
      precision: 'city',
    });
  });

  it('returns null for a state-only feature', () => {
    expect(pickPhotonPlace({ features: [feature('state')] }, 'karnataka', 'IN')).toBeNull();
  });
});
