import { describe, it, expect } from 'vitest';
import Ajv2020 from 'ajv/dist/2020.js';
import {
  URI_FIELD_MARKER,
  URL_PATTERN,
  isUriField,
  applyUriPatterns,
  collectUriFieldKeys,
} from '../uri_fields';

const re = new RegExp(URL_PATTERN, 'u');

describe('URL_PATTERN', () => {
  it.each([
    'example.com',
    'www.example.com',
    'my-site.org',
    'https://example.com',
    'http://sub.domain.co.uk/a/b?q=1#f',
    'https://example.com:8443/x',
    '  https://example.com  ',
    'EXAMPLE.COM',
    '',
    '   ',
  ])('accepts %j', (value) => {
    expect(re.test(value)).toBe(true);
  });

  it.each([
    'companyabc',
    'javascript:alert(1)',
    'data:text/html,x',
    'ftp://example.com',
    'http://localhost:3000',
    'http://192.168.1.1',
    'a@b.com',
    'foo bar',
    'https://',
  ])('rejects %j', (value) => {
    expect(re.test(value)).toBe(false);
  });

  it('is enforced by the API ajv config (strict:false, no ajv-formats)', () => {
    const ajv = new Ajv2020({ strict: false, allErrors: true });
    const validate = ajv.compile({
      type: 'object',
      properties: { site: { type: 'string', pattern: URL_PATTERN } },
    });
    expect(validate({ site: 'companyabc' })).toBe(false);
    expect(validate({ site: 'example.com' })).toBe(true);
  });
});

describe('isUriField', () => {
  it('is true only for the exact boolean marker', () => {
    expect(isUriField({ [URI_FIELD_MARKER]: true })).toBe(true);
    expect(isUriField({ [URI_FIELD_MARKER]: 'true' })).toBe(false);
    expect(isUriField({ [URI_FIELD_MARKER]: false })).toBe(false);
    expect(isUriField({})).toBe(false);
    expect(isUriField(null)).toBe(false);
    expect(isUriField('x')).toBe(false);
  });
});

describe('applyUriPatterns', () => {
  it('injects the pattern on a marked string property', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: { site: { type: 'string', 'x-uri': true } },
    }) as any;
    expect(out.properties.site.pattern).toBe(URL_PATTERN);
  });

  it('leaves unmarked properties untouched', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: { name: { type: 'string' } },
    }) as any;
    expect(out.properties.name.pattern).toBeUndefined();
  });

  it('never overwrites an author-supplied pattern', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: { site: { type: 'string', 'x-uri': true, pattern: '^custom$' } },
    }) as any;
    expect(out.properties.site.pattern).toBe('^custom$');
  });

  it('injects into items for a marked array-of-strings', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: {
        links: { type: 'array', 'x-uri': true, items: { type: 'string' } },
      },
    }) as any;
    expect(out.properties.links.items.pattern).toBe(URL_PATTERN);
    expect(out.properties.links.pattern).toBeUndefined();
  });

  it('recurses into nested object properties', () => {
    const out = applyUriPatterns({
      type: 'object',
      properties: {
        org: {
          type: 'object',
          properties: { site: { type: 'string', 'x-uri': true } },
        },
      },
    }) as any;
    expect(out.properties.org.properties.site.pattern).toBe(URL_PATTERN);
  });

  it('does not mutate the input schema', () => {
    const input = { type: 'object', properties: { site: { type: 'string', 'x-uri': true } } };
    const snapshot = JSON.stringify(input);
    applyUriPatterns(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it('returns non-object input unchanged', () => {
    expect(applyUriPatterns(null as any)).toBeNull();
    expect(applyUriPatterns(undefined as any)).toBeUndefined();
  });
});

describe('collectUriFieldKeys', () => {
  it('returns the top-level marked property names', () => {
    expect(
      collectUriFieldKeys({
        type: 'object',
        properties: {
          site: { type: 'string', 'x-uri': true },
          links: { type: 'array', 'x-uri': true, items: { type: 'string' } },
          name: { type: 'string' },
        },
      }),
    ).toEqual(['site', 'links']);
  });

  it('returns an empty array for a schema with no properties', () => {
    expect(collectUriFieldKeys({ type: 'object' })).toEqual([]);
    expect(collectUriFieldKeys(null)).toEqual([]);
  });
});
