import { describe, it, expect } from 'vitest';
import {
  shouldShowFieldErrors,
  SUBMIT_ATTEMPTED_KEY,
  TOUCHED_FIELDS_KEY,
} from './field-error-visibility';

const ctx = (touched: string[], submitAttempted = false) => ({
  [TOUCHED_FIELDS_KEY]: new Set(touched),
  [SUBMIT_ATTEMPTED_KEY]: submitAttempted,
});

describe('shouldShowFieldErrors', () => {
  it('hides an untouched field and shows a touched one', () => {
    expect(shouldShowFieldErrors('root_website', ctx([]))).toBe(false);
    expect(shouldShowFieldErrors('root_website', ctx(['root_website']))).toBe(true);
  });

  it('does not leak between sibling fields', () => {
    // The bug this guards: any blur anywhere used to reveal every field's error.
    expect(shouldShowFieldErrors('root_address', ctx(['root_email']))).toBe(false);
  });

  it('treats a container as visited when one of its children is', () => {
    expect(shouldShowFieldErrors('root_reference_links', ctx(['root_reference_links_0']))).toBe(true);
  });

  it('does not treat a field as visited on a mere name-prefix collision', () => {
    // `root_web` is a different field from `root_website`; only the `_` child
    // separator counts as containment.
    expect(shouldShowFieldErrors('root_web', ctx(['root_website']))).toBe(false);
  });

  it('shows everything once a submit has been attempted', () => {
    expect(shouldShowFieldErrors('root_anything', ctx([], true))).toBe(true);
  });

  it('shows errors when no gate is present, so widgets used outside SchemaForm are unaffected', () => {
    expect(shouldShowFieldErrors('root_website', undefined)).toBe(true);
    expect(shouldShowFieldErrors('root_website', {})).toBe(true);
  });
});
