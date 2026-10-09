import { describe, it, expect } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';
import {
  filterOptionLabel,
  getEnumFilterFields,
  getEnumFilterFieldsForDomains,
  itemPassesEnumFilters,
} from './enum-filters';

// #203 map-serverside-search Task 7: the filters panel must never offer a
// `private: true` field as a filter option, even though the server's facet
// guard (`resolveAllowedFacetFields`, apps/api's item_fetch_runtime.ts) would
// silently drop any filter request on one anyway — defense-in-depth so a
// private+enum field doesn't even render as a (silently inert) UI choice.
describe('getEnumFilterFields — private field exclusion (#203 Task 7)', () => {
  it('excludes a private single-value enum field', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        gender: { type: 'string', enum: ['female', 'male'] },
        ssn_last_four: { type: 'string', enum: ['1234', '5678'], private: true },
      },
    } as RJSFSchema;

    const fields = getEnumFilterFields([schema]);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('gender');
    expect(keys).not.toContain('ssn_last_four');
  });

  it('excludes a private array-of-enum field', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        looking_for: { type: 'array', items: { enum: ['a', 'b'] } },
        secret_tags: { type: 'array', items: { enum: ['x', 'y'] }, private: true },
      },
    } as RJSFSchema;

    const fields = getEnumFilterFields([schema]);
    const keys = fields.map((f) => f.key);
    expect(keys).toContain('looking_for');
    expect(keys).not.toContain('secret_tags');
  });

  it('a non-private enum field with no private marker at all is still included (no regression)', () => {
    const schema: RJSFSchema = {
      type: 'object',
      properties: {
        gender: { type: 'string', enum: ['female', 'male'] },
      },
    } as RJSFSchema;

    const fields = getEnumFilterFields([schema]);
    expect(fields.map((f) => f.key)).toEqual(['gender']);
  });
});

// #394: the map and the list get the same fields from this one function (the
// map-only `{ filterableOnly: true }` option was removed). For a schema with
// no `filterable` marker that is every declared, non-private enum field; a
// schema that marks any narrows to the marked ones (infra#57, tested below). See #360 for the proper long-term
// schema-driven search/filter declaration.
describe('getEnumFilterFieldsForDomains — all declared enum fields, no filterable gate (#394)', () => {
  function domainWithSchema(id: string, properties: Record<string, unknown>): DotNetworkDomain {
    return {
      id,
      description: id,
      item_schemas: {
        'profile_1.0': { type: 'object', properties } as unknown as RJSFSchema,
      },
    } as DotNetworkDomain;
  }

  it('blue_dot-style schema: returns every declared enum field regardless of any former filterable marker', () => {
    const domain = domainWithSchema('seeker', {
      gender: { type: 'string', enum: ['female', 'male'] },
      work_experience: { type: 'string', enum: ['fresher', 'experienced'] },
      nature_of_job: { type: 'array', items: { enum: ['full_time', 'part_time'] } },
      preferred_language: { type: 'string', enum: ['en', 'hi', 'kn'] },
    });

    const fields = getEnumFilterFieldsForDomains([domain]);
    expect(fields.map((f) => f.key).sort()).toEqual(
      ['gender', 'nature_of_job', 'preferred_language', 'work_experience'].sort(),
    );
  });

  it('a `private: true` field is still excluded (the one remaining, security-motivated gate)', () => {
    const domain = domainWithSchema('seeker', {
      favourite_subject: { type: 'string', enum: ['math', 'science'] },
      ssn_last_four: { type: 'string', enum: ['1234', '5678'], private: true },
    });

    const fields = getEnumFilterFieldsForDomains([domain]);
    expect(fields.map((f) => f.key)).toEqual(['favourite_subject']);
  });

  it('a field declared in only one of several domains is still offered (union across domains)', () => {
    const seeker = domainWithSchema('seeker', {
      gender: { type: 'string', enum: ['female', 'male'] },
      city: { type: 'string', enum: ['blr', 'del'] },
    });
    const provider = domainWithSchema('provider', {
      city: { type: 'string', enum: ['blr', 'del'] },
    });

    expect(getEnumFilterFieldsForDomains([seeker, provider]).map((f) => f.key).sort()).toEqual(['city', 'gender']);
  });
});

// infra#57: once a schema marks any field `filterable: true`, only the marked
// fields are filters; a marked boolean becomes a Yes/No filter.
describe('getEnumFilterFields — filterable marker (infra#57)', () => {
  it('without markers keeps every non-private enum and ignores booleans', () => {
    const schema = {
      type: 'object',
      properties: {
        natureOfJob: { type: 'string', enum: ['Full-time'] },
        category: { type: 'string', enum: ['GEN'] },
        isGovernmentJob: { type: 'boolean' },
      },
    } as RJSFSchema;
    expect(getEnumFilterFields([schema]).map((f) => f.key)).toEqual(['natureOfJob', 'category']);
  });

  it('with markers offers only the marked fields', () => {
    const schema = {
      type: 'object',
      properties: {
        natureOfJob: { type: 'string', enum: ['Full-time', 'Part-time'], filterable: true },
        category: { type: 'string', enum: ['GEN'] },
        genderPreference: { type: 'string', enum: ['Male', 'Any'], filterable: true },
      },
    } as RJSFSchema;
    expect(getEnumFilterFields([schema]).map((f) => f.key)).toEqual([
      'natureOfJob',
      'genderPreference',
    ]);
  });

  it('turns a marked boolean into a toggle that filters to true', () => {
    const schema = {
      type: 'object',
      properties: {
        isGovernmentJob: { type: 'boolean', title: 'Government Job', filterable: true },
      },
    } as RJSFSchema;
    const [field] = getEnumFilterFields([schema]);
    expect(field).toEqual({
      key: 'isGovernmentJob',
      label: 'Government Job',
      options: ['true'],
      isArray: false,
      optionLabels: { true: 'filters.option_yes', false: 'filters.option_no' },
      widget: 'toggle',
    });
    const t = (key: string) => `t:${key}`;
    expect(filterOptionLabel(field, 'true', t)).toBe('t:filters.option_yes');
    expect(filterOptionLabel(field, 'Other', t)).toBe('Other');
  });

  it('matches a boolean item value against the "true"/"false" selection', () => {
    const fields = getEnumFilterFields([
      {
        type: 'object',
        properties: { isGovernmentJob: { type: 'boolean', filterable: true } },
      } as RJSFSchema,
    ]);
    expect(itemPassesEnumFilters({ isGovernmentJob: true }, { isGovernmentJob: ['true'] }, fields)).toBe(true);
    expect(itemPassesEnumFilters({ isGovernmentJob: false }, { isGovernmentJob: ['true'] }, fields)).toBe(false);
  });
});

describe('range and include-value filters (infra#57)', () => {
  const jobSchema = {
    type: 'object',
    properties: {
      salaryMin: {
        type: 'number',
        title: 'Monthly salary min',
        filterable: true,
        'x-range-filter': {
          title: 'Salary Ranges',
          max_field: 'salaryMax',
          buckets: [
            { label: '0-3 LPA', min: 0, max: 25000 },
            { label: '3-6 LPA', min: 25000, max: 50000 },
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
  } as RJSFSchema;
  const fields = getEnumFilterFields([jobSchema]);

  it('offers range buckets as a range group', () => {
    expect(fields[0]).toMatchObject({
      key: 'salaryMin',
      label: 'Salary Ranges',
      options: ['0-3 LPA', '3-6 LPA'],
      widget: 'range',
    });
  });

  it('renders an include-values field as a radio group', () => {
    expect(fields[1]).toMatchObject({ key: 'genderPreference', widget: 'radio', includeValues: ['Any'] });
  });

  it('matches a job whose salary range overlaps the bucket', () => {
    const pick = { salaryMin: ['3-6 LPA'] };
    expect(itemPassesEnumFilters({ salaryMin: 20000, salaryMax: 30000 }, pick, fields)).toBe(true);
    expect(itemPassesEnumFilters({ salaryMin: 60000, salaryMax: 80000 }, pick, fields)).toBe(false);
    expect(itemPassesEnumFilters({ salaryMin: 30000 }, pick, fields)).toBe(false);
  });

  it('lets an "Any" job through a specific gender selection', () => {
    const pick = { genderPreference: ['Female'] };
    expect(itemPassesEnumFilters({ genderPreference: 'Any' }, pick, fields)).toBe(true);
    expect(itemPassesEnumFilters({ genderPreference: 'Male' }, pick, fields)).toBe(false);
  });
});
