import { describe, it, expect } from 'vitest';
import {
  parseLocationFields,
  getAutocompleteLocationFields,
  isLocationFieldPrivate,
  buildLocationQueries,
  primaryAddressChanged,
  isPrimaryAddressBlank,
  assertSinglePrimaryLocation,
} from '../location_fields';

const singlePrimary = {
  properties: { address: { type: 'string', location: 'primary' } },
};
const arrayPrimary = {
  properties: { service_cities: { type: 'array', location: 'primary' } },
};

describe('parseLocationFields defensive inputs', () => {
  it('returns an empty result for null, undefined and a schema without properties', () => {
    const empty = { primary: null, secondary: [] };
    expect(parseLocationFields(null)).toEqual(empty);
    expect(parseLocationFields(undefined)).toEqual(empty);
    expect(parseLocationFields({ type: 'object' })).toEqual(empty);
  });

  it('ignores properties with no location marker or a null value', () => {
    const schema = {
      properties: {
        bio: { type: 'string' },
        broken: null,
        address: { type: 'string', location: 'primary' },
      },
    };
    expect(parseLocationFields(schema)).toEqual({
      primary: { field: 'address', cardinality: 'single' },
      secondary: [],
    });
  });

  it('keeps the first primary when a schema wrongly declares two', () => {
    const schema = {
      properties: {
        address: { type: 'string', location: 'primary' },
        second_address: { type: 'array', location: 'primary' },
      },
    };
    expect(parseLocationFields(schema).primary).toEqual({
      field: 'address',
      cardinality: 'single',
    });
  });
});

describe('getAutocompleteLocationFields / isLocationFieldPrivate without a primary', () => {
  it('returns only the secondary fields when nothing is primary', () => {
    const schema = { properties: { org_address: { type: 'string', location: 'secondary' } } };
    expect(getAutocompleteLocationFields(schema)).toEqual([
      { field: 'org_address', cardinality: 'single' },
    ]);
  });

  it('is not private when there is no primary field', () => {
    expect(isLocationFieldPrivate({ properties: {} })).toBe(false);
  });

  it('is not private when the primary field omits the private marker', () => {
    expect(isLocationFieldPrivate(singlePrimary)).toBe(false);
  });

  it('is private only when the primary field is marked private: true', () => {
    expect(
      isLocationFieldPrivate({
        properties: { address: { type: 'string', location: 'primary', private: true } },
      }),
    ).toBe(true);
    // A truthy-but-not-true marker must not count.
    expect(
      isLocationFieldPrivate({
        properties: { address: { type: 'string', location: 'primary', private: 'yes' } },
      }),
    ).toBe(false);
  });
});

describe('buildLocationQueries', () => {
  it('returns [] when there is no primary field', () => {
    expect(buildLocationQueries({ address: 'Pune' }, null)).toEqual([]);
  });

  it('returns [] for a multiple-cardinality field whose value is not an array', () => {
    expect(
      buildLocationQueries({ service_cities: 'Pune' }, parseLocationFields(arrayPrimary).primary),
    ).toEqual([]);
  });

  it('drops blank and non-string array entries and trims the rest', () => {
    expect(
      buildLocationQueries(
        { service_cities: ['  Pune  ', '', '   ', 7, null, 'Mumbai'] },
        parseLocationFields(arrayPrimary).primary,
      ),
    ).toEqual([
      { query: 'Pune', label: 'Pune' },
      { query: 'Mumbai', label: 'Mumbai' },
    ]);
  });

  it('returns [] for a single field that is blank, missing or non-string', () => {
    const primary = parseLocationFields(singlePrimary).primary;
    expect(buildLocationQueries({ address: '   ' }, primary)).toEqual([]);
    expect(buildLocationQueries({}, primary)).toEqual([]);
    expect(buildLocationQueries({ address: 12345 }, primary)).toEqual([]);
  });

  it('trims a single string field into one query with no label', () => {
    expect(
      buildLocationQueries({ address: ' 221B Baker St ' }, parseLocationFields(singlePrimary).primary),
    ).toEqual([{ query: '221B Baker St' }]);
  });
});

describe('primaryAddressChanged', () => {
  it('is false when the schema declares no primary field', () => {
    expect(primaryAddressChanged({ properties: {} }, { address: 'Pune' }, {})).toBe(false);
  });

  it('is false when the partial payload omits the primary field key', () => {
    expect(primaryAddressChanged(singlePrimary, { bio: 'hi' }, { address: 'Pune' })).toBe(false);
  });

  it('is true when the key is present with a different value', () => {
    expect(primaryAddressChanged(singlePrimary, { address: 'Mumbai' }, { address: 'Pune' })).toBe(
      true,
    );
  });

  it('is false when the key is present with the same value', () => {
    expect(primaryAddressChanged(singlePrimary, { address: 'Pune' }, { address: 'Pune' })).toBe(
      false,
    );
  });

  it('treats an explicit null/undefined-to-value change as a change', () => {
    expect(primaryAddressChanged(singlePrimary, { address: null }, { address: 'Pune' })).toBe(true);
    expect(primaryAddressChanged(singlePrimary, { address: 'Pune' }, {})).toBe(true);
  });

  it('treats array reordering as a change', () => {
    expect(
      primaryAddressChanged(
        arrayPrimary,
        { service_cities: ['Mumbai', 'Pune'] },
        { service_cities: ['Pune', 'Mumbai'] },
      ),
    ).toBe(true);
  });
});

describe('isPrimaryAddressBlank', () => {
  it('is false when the schema declares no primary field', () => {
    expect(isPrimaryAddressBlank({ properties: {} }, { address: '' })).toBe(false);
  });

  it('is true for missing, null, empty-string and whitespace values', () => {
    expect(isPrimaryAddressBlank(singlePrimary, {})).toBe(true);
    expect(isPrimaryAddressBlank(singlePrimary, { address: null })).toBe(true);
    expect(isPrimaryAddressBlank(singlePrimary, { address: '' })).toBe(true);
    expect(isPrimaryAddressBlank(singlePrimary, { address: '   ' })).toBe(true);
  });

  it('is true for an empty array and false for a populated one', () => {
    expect(isPrimaryAddressBlank(arrayPrimary, { service_cities: [] })).toBe(true);
    expect(isPrimaryAddressBlank(arrayPrimary, { service_cities: ['Pune'] })).toBe(false);
  });

  it('is false for a non-string, non-array value (nothing was cleared)', () => {
    expect(isPrimaryAddressBlank(singlePrimary, { address: 0 })).toBe(false);
    expect(isPrimaryAddressBlank(singlePrimary, { address: { city: 'Pune' } })).toBe(false);
  });
});

describe('assertSinglePrimaryLocation', () => {
  it('passes for exactly one primary field', () => {
    expect(() => assertSinglePrimaryLocation(singlePrimary, 'student/profile_1.0')).not.toThrow();
  });

  it('throws with the count when there is none', () => {
    expect(() => assertSinglePrimaryLocation({ properties: {} }, 'student/profile_1.0')).toThrow(
      'student/profile_1.0: item schema must declare exactly one "location": "primary" field, found 0.',
    );
  });

  it('throws with the count when there are two', () => {
    const schema = {
      properties: {
        a: { type: 'string', location: 'primary' },
        b: { type: 'string', location: 'primary' },
      },
    };
    expect(() => assertSinglePrimaryLocation(schema, 'college/profile_1.0')).toThrow('found 2.');
  });

  it('throws for a null or undefined schema', () => {
    expect(() => assertSinglePrimaryLocation(null, 'ctx')).toThrow('found 0.');
    expect(() => assertSinglePrimaryLocation(undefined, 'ctx')).toThrow('found 0.');
  });
});
