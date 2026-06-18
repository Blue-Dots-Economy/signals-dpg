import { describe, it, expect } from 'vitest';
import {
  parseLocationFields,
  buildLocationQueries,
  isLocationFieldPrivate,
  getAutocompleteLocationFields,
  assertSinglePrimaryLocation,
  primaryAddressChanged,
  isPrimaryAddressBlank,
} from '../location_fields';

const primaryString = {
  properties: { address: { type: 'string', location: 'primary' } },
};
const primaryArray = {
  properties: { service_cities: { type: 'array', location: 'primary' } },
};
const withSecondary = {
  properties: {
    address: { type: 'string', location: 'primary', private: true },
    orgAddress: { type: 'string', location: 'secondary' },
    serviceAreas: { type: 'array', location: 'secondary' },
  },
};

describe('parseLocationFields', () => {
  it('reads a single primary (cardinality from string type)', () => {
    expect(parseLocationFields(primaryString)).toEqual({
      primary: { field: 'address', cardinality: 'single' },
      secondary: [],
    });
  });

  it('derives multiple cardinality from array type', () => {
    expect(parseLocationFields(primaryArray).primary).toEqual({
      field: 'service_cities',
      cardinality: 'multiple',
    });
  });

  it('collects secondary fields with their cardinality', () => {
    const { primary, secondary } = parseLocationFields(withSecondary);
    expect(primary).toEqual({ field: 'address', cardinality: 'single' });
    expect(secondary).toEqual([
      { field: 'orgAddress', cardinality: 'single' },
      { field: 'serviceAreas', cardinality: 'multiple' },
    ]);
  });

  it('returns null primary when none is marked', () => {
    expect(parseLocationFields({ properties: { name: { type: 'string' } } })).toEqual({
      primary: null,
      secondary: [],
    });
  });
});

describe('getAutocompleteLocationFields', () => {
  it('returns primary first, then all secondary', () => {
    expect(getAutocompleteLocationFields(withSecondary).map((f) => f.field)).toEqual([
      'address',
      'orgAddress',
      'serviceAreas',
    ]);
  });
});

describe('buildLocationQueries (primary only)', () => {
  it('single primary -> one query from the string', () => {
    expect(
      buildLocationQueries({ address: 'Mumbai' }, { field: 'address', cardinality: 'single' })
    ).toEqual([{ query: 'Mumbai' }]);
  });

  it('multiple primary -> one query+label per entry', () => {
    expect(
      buildLocationQueries(
        { service_cities: ['Pune', ' Mumbai '] },
        { field: 'service_cities', cardinality: 'multiple' }
      )
    ).toEqual([
      { query: 'Pune', label: 'Pune' },
      { query: 'Mumbai', label: 'Mumbai' },
    ]);
  });

  it('null primary -> no queries (secondary never geocoded)', () => {
    expect(buildLocationQueries({ orgAddress: 'X' }, null)).toEqual([]);
  });
});

describe('isLocationFieldPrivate', () => {
  it('reads the primary field private flag', () => {
    expect(isLocationFieldPrivate(withSecondary)).toBe(true);
    expect(isLocationFieldPrivate(primaryString)).toBe(false);
  });
});

describe('primaryAddressChanged', () => {
  const noPrimary = { properties: { name: { type: 'string' } } };

  it('returns false when the schema has no primary location field', () => {
    expect(primaryAddressChanged(noPrimary, { name: 'New' }, { name: 'Old' })).toBe(false);
  });

  it('returns false when the primary field is absent from the partial update', () => {
    expect(
      primaryAddressChanged(primaryString, { name: 'X' }, { address: 'Mumbai' })
    ).toBe(false);
  });

  it('returns false when the primary field is present but unchanged', () => {
    expect(
      primaryAddressChanged(primaryString, { address: 'Mumbai' }, { address: 'Mumbai' })
    ).toBe(false);
  });

  it('returns true when the primary field is present and its value differs', () => {
    expect(
      primaryAddressChanged(primaryString, { address: 'Pune' }, { address: 'Mumbai' })
    ).toBe(true);
  });

  it('treats a newly-set value (absent prior) as changed', () => {
    expect(primaryAddressChanged(primaryString, { address: 'Pune' }, {})).toBe(true);
  });

  it('returns true when a multiple-cardinality array value changes', () => {
    expect(
      primaryAddressChanged(
        primaryArray,
        { service_cities: ['Pune', 'Mumbai'] },
        { service_cities: ['Pune'] }
      )
    ).toBe(true);
  });

  it('returns false when a multiple-cardinality array value is identical', () => {
    expect(
      primaryAddressChanged(
        primaryArray,
        { service_cities: ['Pune', 'Mumbai'] },
        { service_cities: ['Pune', 'Mumbai'] }
      )
    ).toBe(false);
  });
});

describe('isPrimaryAddressBlank', () => {
  const noPrimary = { properties: { name: { type: 'string' } } };

  it('returns false when the schema has no primary field', () => {
    expect(isPrimaryAddressBlank(noPrimary, { name: 'x' })).toBe(false);
  });
  it('treats missing / null / empty / whitespace string as blank', () => {
    expect(isPrimaryAddressBlank(primaryString, {})).toBe(true);
    expect(isPrimaryAddressBlank(primaryString, { address: null })).toBe(true);
    expect(isPrimaryAddressBlank(primaryString, { address: '' })).toBe(true);
    expect(isPrimaryAddressBlank(primaryString, { address: '   ' })).toBe(true);
  });
  it('treats a non-empty string as not blank', () => {
    expect(isPrimaryAddressBlank(primaryString, { address: 'Pune' })).toBe(false);
  });
  it('treats an empty array as blank and a non-empty array as not blank', () => {
    expect(isPrimaryAddressBlank(primaryArray, { service_cities: [] })).toBe(true);
    expect(isPrimaryAddressBlank(primaryArray, { service_cities: ['Pune'] })).toBe(false);
  });
});

// Reviewer case: an UPDATE that clears the primary address must be detectable
// as "cleared" (→ wipe coords) rather than conflated with a geocode failure.
describe('clearing the primary address (changed + blank)', () => {
  it('is reported as both changed and blank', () => {
    expect(primaryAddressChanged(primaryString, { address: '' }, { address: 'Mumbai' })).toBe(true);
    expect(isPrimaryAddressBlank(primaryString, { address: '' })).toBe(true);
  });
});

describe('assertSinglePrimaryLocation', () => {
  it('passes with exactly one primary', () => {
    expect(() => assertSinglePrimaryLocation(withSecondary, 'net/dom/type')).not.toThrow();
  });
  it('throws with zero primaries', () => {
    expect(() =>
      assertSinglePrimaryLocation({ properties: { a: { type: 'string' } } }, 'net/dom/type')
    ).toThrow(/exactly one .* found 0/);
  });
  it('throws with two primaries', () => {
    expect(() =>
      assertSinglePrimaryLocation(
        { properties: { a: { type: 'string', location: 'primary' }, b: { type: 'string', location: 'primary' } } },
        'net/dom/type'
      )
    ).toThrow(/found 2/);
  });
});
