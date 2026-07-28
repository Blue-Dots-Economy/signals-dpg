import { describe, it, expect } from 'vitest';
import type { RJSFSchema } from '@rjsf/utils';
import { getEnumFilterFields } from './enum-filters';

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
