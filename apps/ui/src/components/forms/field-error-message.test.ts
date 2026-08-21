import { describe, it, expect } from 'vitest';
import { resolvePatternErrorMessage } from './field-error-message';

const messages = {
  uri: 'Enter a valid link, e.g. https://example.com',
  generic: (label: string) => `Please enter a valid ${label}.`,
};

describe('resolvePatternErrorMessage', () => {
  it("prefers the schema author's own copy", () => {
    const schema = {
      title: 'Mobile',
      pattern: '^[0-9]{10}$',
      'x-error-message': 'Enter a 10-digit mobile number, no spaces.',
    };
    expect(resolvePatternErrorMessage(schema, false, messages)).toBe(
      'Enter a 10-digit mobile number, no spaces.',
    );
  });

  it("uses the author's copy even on an x-uri field", () => {
    const schema = { title: 'Catalog', 'x-uri': true, 'x-error-message': 'Paste your catalogue link.' };
    expect(resolvePatternErrorMessage(schema, true, messages)).toBe('Paste your catalogue link.');
  });

  it('falls back to the URL copy for an x-uri field', () => {
    expect(resolvePatternErrorMessage({ title: 'Website' }, true, messages)).toBe(messages.uri);
  });

  it('names the field for any other pattern, so no network shows a regex', () => {
    // A network declaring a bare `pattern` with no copy still gets something
    // readable — this is the case that used to render the raw AJV message.
    expect(resolvePatternErrorMessage({ title: 'Mobile', pattern: '^[0-9]{10}$' }, false, messages)).toBe(
      'Please enter a valid Mobile.',
    );
  });

  it('degrades to a neutral word when the field has no title', () => {
    expect(resolvePatternErrorMessage({ pattern: '^x$' }, false, messages)).toBe(
      'Please enter a valid value.',
    );
  });

  it('ignores a blank or non-string authored message', () => {
    expect(resolvePatternErrorMessage({ title: 'Mobile', 'x-error-message': '  ' }, false, messages)).toBe(
      'Please enter a valid Mobile.',
    );
    expect(resolvePatternErrorMessage({ title: 'Mobile', 'x-error-message': 42 }, false, messages)).toBe(
      'Please enter a valid Mobile.',
    );
  });

  it('handles a missing property schema', () => {
    expect(resolvePatternErrorMessage(undefined, false, messages)).toBe('Please enter a valid value.');
  });
});
