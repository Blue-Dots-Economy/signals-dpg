import { describe, it, expect } from 'vitest';
import type { ErrorSchema } from '@rjsf/utils';
import { filterErrorSchemaToVisited, isFieldVisited } from './field-error-visibility';

const touched = (...ids: string[]) => new Set(ids);

describe('isFieldVisited', () => {
  it('is false for a field the user has never been to', () => {
    expect(isFieldVisited('website', touched())).toBe(false);
    expect(isFieldVisited('website', touched('root_email'))).toBe(false);
  });

  it('is true for the visited field itself', () => {
    expect(isFieldVisited('website', touched('root_website'))).toBe(true);
  });

  it('counts a container as visited when one of its children is', () => {
    expect(isFieldVisited('reference_links', touched('root_reference_links_0'))).toBe(true);
  });

  it('does not match on a mere name prefix', () => {
    // `web` and `website` are different fields; only the `_` child separator counts.
    expect(isFieldVisited('web', touched('root_website'))).toBe(false);
  });
});

describe('filterErrorSchemaToVisited', () => {
  const full = {
    name: { __errors: ["must have required property 'name'"] },
    age: { __errors: ["must have required property 'age'"] },
    website: { __errors: ['must match pattern "…"'] },
  } as unknown as ErrorSchema;

  it('hands back nothing for a pristine form', () => {
    // The reported bug: typing one letter reddened every required field, because
    // every invalid field had an error to render. An untouched field must get none.
    expect(filterErrorSchemaToVisited(full, touched(), false)).toEqual({});
  });

  it('passes through only the visited field, not its siblings', () => {
    expect(filterErrorSchemaToVisited(full, touched('root_website'), false)).toEqual({
      website: { __errors: ['must match pattern "…"'] },
    });
  });

  it('supplies nothing once a submit has been attempted, so messages are not doubled', () => {
    // RJSF validates natively on submit and renders every field's error itself;
    // adding ours on top printed each message twice.
    expect(filterErrorSchemaToVisited(full, touched(), true)).toEqual({});
  });

  it('drops root-level __errors while filtering', () => {
    const withRoot = { __errors: ['form is wrong'], website: { __errors: ['bad'] } } as unknown as ErrorSchema;
    expect(filterErrorSchemaToVisited(withRoot, touched('root_website'), false)).toEqual({
      website: { __errors: ['bad'] },
    });
  });

  it('supplies nothing after a submit attempt even for root-level errors', () => {
    const withRoot = { __errors: ['form is wrong'] } as unknown as ErrorSchema;
    expect(filterErrorSchemaToVisited(withRoot, touched(), true)).toEqual({});
  });
});
