import { describe, it, expect } from 'vitest';
import { parseLocationFields, buildLocationQueries } from '../location_fields';

const singleSchema = { properties: { address: { type: 'string', location: 'single' } } };
const multipleSchema = { properties: { service_cities: { type: 'array', location: 'multiple' } } };

describe('parseLocationFields', () => {
  it('captures a single field', () => {
    expect(parseLocationFields(singleSchema)).toEqual({ field: 'address', cardinality: 'single' });
  });
  it('captures a multiple field', () => {
    expect(parseLocationFields(multipleSchema)).toEqual({ field: 'service_cities', cardinality: 'multiple' });
  });
  it('null when no marker', () => {
    expect(parseLocationFields({ properties: { x: { type: 'string' } } })).toEqual({ field: null, cardinality: null });
  });
  it('null for missing/empty schema', () => {
    expect(parseLocationFields(undefined)).toEqual({ field: null, cardinality: null });
  });
});

describe('buildLocationQueries', () => {
  it('multiple → one query+label per non-empty array entry', () => {
    expect(buildLocationQueries({ service_cities: ['Goa', '', 'Hubli'] }, parseLocationFields(multipleSchema)))
      .toEqual([{ query: 'Goa', label: 'Goa' }, { query: 'Hubli', label: 'Hubli' }]);
  });
  it('single → one query, no label', () => {
    expect(buildLocationQueries({ address: 'MG Rd, Bengaluru' }, parseLocationFields(singleSchema)))
      .toEqual([{ query: 'MG Rd, Bengaluru' }]);
  });
  it('returns [] when nothing usable', () => {
    expect(buildLocationQueries({}, parseLocationFields(singleSchema))).toEqual([]);
    expect(buildLocationQueries({ service_cities: [] }, parseLocationFields(multipleSchema))).toEqual([]);
  });
});
