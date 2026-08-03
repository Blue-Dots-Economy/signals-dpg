import { describe, it, expect } from 'vitest';
import {
  resolveAllowedFacetFields,
  resolveAllowedFacetFilters,
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
