import { describe, it, expect } from 'vitest';
import { parseLocationFields, buildGeoQuery } from '../location_fields';

const seekerSchema = {
  type: 'object',
  properties: {
    beneficiary_name: { type: 'string' },
    address: { type: 'string', location: 'primary' },
    service_city: { type: 'string', location: true },
    state: { type: 'string', location: true },
    pincode: { type: 'string', location: true },
  },
};

const touristSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    location: { type: 'string', location: 'primary' },
  },
};

const noMarkerSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, city: { type: 'string' } },
};

describe('parseLocationFields', () => {
  it('returns the primary field and secondary fields in declaration order', () => {
    expect(parseLocationFields(seekerSchema)).toEqual({
      primary: 'address',
      secondary: ['service_city', 'state', 'pincode'],
    });
  });

  it('handles a single primary field with no secondaries', () => {
    expect(parseLocationFields(touristSchema)).toEqual({
      primary: 'location',
      secondary: [],
    });
  });

  it('returns null primary when no field is marked', () => {
    expect(parseLocationFields(noMarkerSchema)).toEqual({
      primary: null,
      secondary: [],
    });
  });
});

describe('buildGeoQuery', () => {
  it('joins primary then secondary values present in the data', () => {
    const data = {
      address: '12 MG Road',
      service_city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    };
    expect(buildGeoQuery(data, parseLocationFields(seekerSchema))).toBe(
      '12 MG Road, Bengaluru, Karnataka, 560001'
    );
  });

  it('skips empty/missing values', () => {
    const data = { address: 'Udupi', service_city: '', pincode: '576101' };
    expect(buildGeoQuery(data, parseLocationFields(seekerSchema))).toBe(
      'Udupi, 576101'
    );
  });

  it('returns null when no marked values are present', () => {
    expect(buildGeoQuery({}, parseLocationFields(seekerSchema))).toBeNull();
  });

  it('returns null when there is no primary field', () => {
    expect(buildGeoQuery({ city: 'X' }, parseLocationFields(noMarkerSchema))).toBeNull();
  });

  it('returns secondary-only join when the primary value is missing', () => {
    const data = { service_city: 'Bengaluru', state: 'Karnataka', pincode: '560001' };
    expect(buildGeoQuery(data, parseLocationFields(seekerSchema))).toBe(
      'Bengaluru, Karnataka, 560001'
    );
  });
});

describe('parseLocationFields — duplicate primary', () => {
  it('keeps the first primary when multiple are marked', () => {
    const schema = {
      type: 'object',
      properties: {
        address: { type: 'string', location: 'primary' },
        alt_address: { type: 'string', location: 'primary' },
      },
    };
    expect(parseLocationFields(schema)).toEqual({ primary: 'address', secondary: [] });
  });
});
