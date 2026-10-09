import { describe, it, expect } from 'vitest';
import {
  resolveAllowedFacetFields,
  resolveAllowedFacetFilters,
  resolveFilterableFacetFields,
  resolveTextSearchFields,
} from '../facet_guard';

const itemSchema = {
  type: 'object',
  properties: {
    city: { type: 'string' },
    skills: { type: 'array', items: { type: 'string' } },
    phone: { type: 'string', private: true },
    secret_notes: { type: 'array', items: { type: 'string' }, private: true },
  },
};

const networkConfig = {
  id: 'blue_dot',
  domains: [
    {
      id: 'seeker',
      item_schemas: { 'profile_1.0': itemSchema },
    },
  ],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('resolveAllowedFacetFields', () => {
  it('includes public scalar and array fields, tagging arrayValued correctly', () => {
    const allowed = resolveAllowedFacetFields(itemSchema);

    expect(allowed.get('city')).toEqual({ arrayValued: false });
    expect(allowed.get('skills')).toEqual({ arrayValued: true });
  });

  it('excludes fields marked private, scalar or array', () => {
    const allowed = resolveAllowedFacetFields(itemSchema);

    expect(allowed.has('phone')).toBe(false);
    expect(allowed.has('secret_notes')).toBe(false);
  });

  it('returns an empty map when the schema has no properties', () => {
    expect(resolveAllowedFacetFields({}).size).toBe(0);
  });
});

describe('resolveAllowedFacetFilters', () => {
  it('keeps declared, non-private facet selections and attaches arrayValued', () => {
    const result = resolveAllowedFacetFilters(networkConfig, 'seeker', 'profile_1.0', [
      { field: 'city', values: ['pune'] },
      { field: 'skills', values: ['plumbing', 'wiring'] },
    ]);

    expect(result).toEqual([
      { field: 'city', values: ['pune'], arrayValued: false },
      { field: 'skills', values: ['plumbing', 'wiring'], arrayValued: true },
    ]);
  });

  it('drops selections on private fields', () => {
    const result = resolveAllowedFacetFilters(networkConfig, 'seeker', 'profile_1.0', [
      { field: 'phone', values: ['555'] },
    ]);

    expect(result).toEqual([]);
  });

  it('drops selections on undeclared fields not present in the schema at all', () => {
    const result = resolveAllowedFacetFilters(networkConfig, 'seeker', 'profile_1.0', [
      { field: 'not_a_real_field', values: ['x'] },
    ]);

    expect(result).toEqual([]);
  });

  it('drops disallowed selections while keeping allowed ones in the same call', () => {
    const result = resolveAllowedFacetFilters(networkConfig, 'seeker', 'profile_1.0', [
      { field: 'city', values: ['pune'] },
      { field: 'phone', values: ['555'] },
      { field: 'secret_notes', values: ['x'] },
    ]);

    expect(result).toEqual([{ field: 'city', values: ['pune'], arrayValued: false }]);
  });
});

describe('resolveTextSearchFields (#394, moved from markers.ts for reuse by discover.ts)', () => {
  it('returns non-private field keys for a given item_type, excluding private fields', () => {
    const fields = resolveTextSearchFields(networkConfig, 'seeker', 'profile_1.0');

    expect(fields.sort()).toEqual(['city', 'skills']);
    expect(fields).not.toContain('phone');
    expect(fields).not.toContain('secret_notes');
  });

  it('unions non-private fields across every item_type declared for the domain when item_type is omitted', () => {
    const multiTypeNetworkConfig = {
      id: 'blue_dot',
      domains: [
        {
          id: 'seeker',
          item_schemas: {
            'profile_1.0': itemSchema,
            'profile_2.0': {
              type: 'object',
              properties: {
                bio: { type: 'string' },
                ssn: { type: 'string', private: true },
              },
            },
          },
        },
      ],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const fields = resolveTextSearchFields(multiTypeNetworkConfig, 'seeker', undefined);

    expect(fields.sort()).toEqual(['bio', 'city', 'skills']);
    expect(fields).not.toContain('ssn');
  });

  it('fails closed (empty array) for an undefined domain rather than throwing', () => {
    expect(resolveTextSearchFields(networkConfig, 'not_a_domain', 'profile_1.0')).toEqual([]);
  });
});

// infra#57: a schema that marks any field `filterable: true` narrows the
// facets a caller may filter on to the marked ones; text search is unaffected.
describe('filterable marker (infra#57)', () => {
  const jobSchema = {
    type: 'object',
    properties: {
      natureOfJob: { type: 'string', enum: ['Full-time', 'Part-time'], filterable: true },
      category: { type: 'string', enum: ['GEN', 'OBC'] },
      isGovernmentJob: { type: 'boolean', filterable: true },
      role: { type: 'string' },
      phone: { type: 'string', private: true, filterable: true },
    },
  };
  const jobNetwork = {
    id: 'blue_dot',
    domains: [{ id: 'provider', item_schemas: { 'job_posting_1.0': jobSchema } }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  it('keeps only marked, non-private fields', () => {
    expect([...resolveFilterableFacetFields(jobSchema).keys()]).toEqual([
      'natureOfJob',
      'isGovernmentJob',
    ]);
  });

  it('keeps every non-private field when no field is marked', () => {
    expect([...resolveFilterableFacetFields(itemSchema).keys()]).toEqual(['city', 'skills']);
  });

  it('drops a filter on an unmarked field', () => {
    const out = resolveAllowedFacetFilters(jobNetwork, 'provider', 'job_posting_1.0', [
      { field: 'natureOfJob', values: ['Full-time'] },
      { field: 'category', values: ['GEN'] },
      { field: 'phone', values: ['1'] },
    ]);
    expect(out.map((f) => f.field)).toEqual(['natureOfJob']);
  });

  it('sends a boolean facet as JSON booleans', () => {
    const out = resolveAllowedFacetFilters(jobNetwork, 'provider', 'job_posting_1.0', [
      { field: 'isGovernmentJob', values: ['true', 'false'] },
    ]);
    expect(out).toEqual([{ field: 'isGovernmentJob', values: [true, false], arrayValued: false }]);
  });

  it('leaves text search on every non-private field', () => {
    expect(resolveTextSearchFields(jobNetwork, 'provider', 'job_posting_1.0').sort()).toEqual(
      ['category', 'isGovernmentJob', 'natureOfJob', 'role'],
    );
  });
});

describe('range and include-value filters (infra#57)', () => {
  const jobSchema = {
    type: 'object',
    properties: {
      salaryMin: {
        type: 'number',
        filterable: true,
        'x-range-filter': {
          max_field: 'salaryMax',
          buckets: [
            { label: '0-3 LPA', min: 0, max: 25000 },
            { label: '3-6 LPA', min: 25000, max: 50000 },
            { label: '25+ LPA', min: 208333 },
          ],
        },
      },
      salaryMax: { type: 'number' },
      genderPreference: {
        type: 'string',
        enum: ['Male', 'Female', 'Any'],
        filterable: true,
        'x-filter-include-values': ['Any'],
      },
    },
  };
  const jobNetwork = {
    id: 'blue_dot',
    domains: [{ id: 'provider', item_schemas: { 'job_posting_1.0': jobSchema } }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const resolve = (selections: Array<{ field: string; values: string[] }>) =>
    resolveAllowedFacetFilters(jobNetwork, 'provider', 'job_posting_1.0', selections);

  it('turns a bucket label into the bucket bounds', () => {
    expect(resolve([{ field: 'salaryMin', values: ['3-6 LPA'] }])).toEqual([
      { field: 'salaryMin', values: ['3-6 LPA'], range: { maxField: 'salaryMax', min: 25000, max: 50000 } },
    ]);
  });

  it('keeps an open upper bound open', () => {
    expect(resolve([{ field: 'salaryMin', values: ['25+ LPA'] }])[0].range).toEqual({
      maxField: 'salaryMax',
      min: 208333,
    });
  });

  it('covers several buckets with one envelope', () => {
    expect(resolve([{ field: 'salaryMin', values: ['0-3 LPA', '3-6 LPA'] }])[0].range).toEqual({
      maxField: 'salaryMax',
      min: 0,
      max: 50000,
    });
  });

  it('matches nothing, rather than everything, when no label is a declared bucket', () => {
    expect(resolve([{ field: 'salaryMin', values: ['100 LPA'] }])).toEqual([
      { field: 'salaryMin', values: ['100 LPA'], arrayValued: false },
    ]);
  });

  it('adds the include values to an enum selection', () => {
    expect(resolve([{ field: 'genderPreference', values: ['Female'] }])).toEqual([
      { field: 'genderPreference', values: ['Female', 'Any'], arrayValued: false },
    ]);
  });
});
