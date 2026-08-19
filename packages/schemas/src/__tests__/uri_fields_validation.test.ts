import { describe, it, expect } from 'vitest';
import { validateAgainstJsonSchema } from '../network_workflow';

const schema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    site: { type: 'string', 'x-uri': true },
    links: { type: 'array', 'x-uri': true, items: { type: 'string' } },
  },
};

describe('validateAgainstJsonSchema with x-uri fields', () => {
  it('rejects a non-URL value in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: 'companyabc' }, 'item_state'),
    ).toThrow(/Invalid item_state/);
  });

  it('accepts a scheme-less host in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: 'example.com' }, 'item_state'),
    ).not.toThrow();
  });

  it('accepts a full URL in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: 'https://example.com/x' }, 'item_state'),
    ).not.toThrow();
  });

  it('rejects a non-URL entry inside a marked array', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { links: ['https://a.com', 'nope'] }, 'item_state'),
    ).toThrow(/Invalid item_state/);
  });

  it('leaves unmarked fields unconstrained', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { name: 'companyabc' }, 'item_state'),
    ).not.toThrow();
  });

  it('accepts an empty string in a marked field', () => {
    expect(() =>
      validateAgainstJsonSchema(schema, { site: '' }, 'item_state'),
    ).not.toThrow();
  });
});
