import { describe, it, expect } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkDomain } from '@/engine/types';
import { getEnumFilterFields, getEnumFilterFieldsForDomains } from './enum-filters';

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

// #394: dropped the `filterable: true` gate that used to additionally
// restrict which enum fields `getEnumFilterFieldsForDomains` returned for the
// MAP (a `{ filterableOnly: true }` option, removed). Every declared,
// non-private enum field is now offered — in both the map and the list — via
// this same function; the `filterable` marker no longer exists in
// `EnumFilterField` or network.json. See #360 for the proper long-term
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
