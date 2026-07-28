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

// #203 map-serverside-search Task 7 review fix: the server's facet guard
// (`resolveAllowedFacetFields`, apps/api's item_fetch_runtime.ts) only honors
// fields declared `filterable: true` in network.json (Task 1) — a plain enum
// field with no `filterable` marker is a normal form field the server drops
// as a facet filter. `filterableOnly` scopes the returned fields to that set
// so the MAP only offers/sends facets the server will actually act on, while
// the LIST (filterableOnly omitted/false) keeps every enum field.
describe('getEnumFilterFieldsForDomains — filterableOnly (#203 Task 7 review fix)', () => {
  function domainWithSchema(id: string, properties: Record<string, unknown>): DotNetworkDomain {
    return {
      id,
      description: id,
      item_schemas: {
        'profile_1.0': { type: 'object', properties } as unknown as RJSFSchema,
      },
    } as DotNetworkDomain;
  }

  it('blue_dot-style schema: filterableOnly returns only the filterable fields (mirrors the 3 real blue_dot markers)', () => {
    const domain = domainWithSchema('seeker', {
      gender: { type: 'string', enum: ['female', 'male'], filterable: true },
      work_experience: { type: 'string', enum: ['fresher', 'experienced'], filterable: true },
      nature_of_job: { type: 'array', items: { enum: ['full_time', 'part_time'] }, filterable: true },
      // A plain enum field with NO `filterable` marker — this is the bug the
      // review caught: it must be OFFERED to the list but NOT to the map.
      preferred_language: { type: 'string', enum: ['en', 'hi', 'kn'] },
    });

    const listFields = getEnumFilterFieldsForDomains([domain]);
    expect(listFields.map((f) => f.key).sort()).toEqual(
      ['gender', 'nature_of_job', 'preferred_language', 'work_experience'].sort(),
    );

    const mapFields = getEnumFilterFieldsForDomains([domain], { filterableOnly: true });
    expect(mapFields.map((f) => f.key).sort()).toEqual(['gender', 'nature_of_job', 'work_experience'].sort());
    expect(mapFields.map((f) => f.key)).not.toContain('preferred_language');
  });

  it('a network with zero filterable fields (the common case today) returns an empty facet list for the map', () => {
    const domain = domainWithSchema('student', {
      favourite_subject: { type: 'string', enum: ['math', 'science'] },
      grade_level: { type: 'string', enum: ['primary', 'secondary'] },
    });

    const listFields = getEnumFilterFieldsForDomains([domain]);
    expect(listFields.length).toBe(2); // list still offers both — no regression

    const mapFields = getEnumFilterFieldsForDomains([domain], { filterableOnly: true });
    expect(mapFields).toEqual([]);
  });

  it('a field filterable in one domain but not another is still offered; a field filterable nowhere is excluded (documented coarser-than-server union)', () => {
    const seeker = domainWithSchema('seeker', {
      gender: { type: 'string', enum: ['female', 'male'], filterable: true },
      city: { type: 'string', enum: ['blr', 'del'] }, // not filterable in either domain
    });
    const provider = domainWithSchema('provider', {
      gender: { type: 'string', enum: ['female', 'male'] }, // not filterable here
      city: { type: 'string', enum: ['blr', 'del'] },
    });

    const mapFields = getEnumFilterFieldsForDomains([seeker, provider], { filterableOnly: true });
    // `gender` survives (filterable in at least one domain); `city` — offered
    // to the list (2 fields, unfiltered) — must NOT survive the map's
    // filterableOnly union (it's filterable in neither domain).
    expect(mapFields.map((f) => f.key)).toEqual(['gender']);
    expect(getEnumFilterFieldsForDomains([seeker, provider]).map((f) => f.key).sort()).toEqual(['city', 'gender']);
  });
});
