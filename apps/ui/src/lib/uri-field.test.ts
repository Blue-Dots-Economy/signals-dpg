import { describe, it, expect } from 'vitest';
import { toSafeHref } from './uri-field';

describe('toSafeHref', () => {
  it('passes http and https through unchanged', () => {
    expect(toSafeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(toSafeHref('http://example.com')).toBe('http://example.com');
  });

  it('prefixes https:// on a scheme-less host', () => {
    expect(toSafeHref('example.com')).toBe('https://example.com');
    expect(toSafeHref('www.example.com/a')).toBe('https://www.example.com/a');
  });

  it('trims surrounding whitespace', () => {
    expect(toSafeHref('  example.com  ')).toBe('https://example.com');
  });

  it('returns null for a masked value', () => {
    expect(toSafeHref('https://***')).toBeNull();
    expect(toSafeHref('***')).toBeNull();
  });

  it('returns null for a non-http(s) scheme', () => {
    expect(toSafeHref('javascript:alert(1)')).toBeNull();
    expect(toSafeHref('data:text/html,<b>x</b>')).toBeNull();
    expect(toSafeHref('mailto:a@b.com')).toBeNull();
    expect(toSafeHref('ftp://example.com')).toBeNull();
  });

  it('returns null for blank input', () => {
    expect(toSafeHref('')).toBeNull();
    expect(toSafeHref('   ')).toBeNull();
  });

  it('returns null for something that cannot be a URL', () => {
    expect(toSafeHref('companyabc')).toBeNull();
    expect(toSafeHref('foo bar')).toBeNull();
  });
});
