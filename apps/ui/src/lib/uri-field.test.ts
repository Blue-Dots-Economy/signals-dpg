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

  it('prefixes https:// on a scheme-less host:port, not mistaken for an explicit scheme', () => {
    expect(toSafeHref('example.com:8080')).toBe('https://example.com:8080');
    expect(toSafeHref('mysite.io:8080/path')).toBe('https://mysite.io:8080/path');
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

  // URL_PATTERN's port group is `(:\d{1,5})?`, so an out-of-range port passes
  // form/API validation, but `new URL` rejects it. Accepted degrade: the value
  // renders as plain text rather than a broken link.
  it('returns null for an out-of-range port that the pattern accepts', () => {
    expect(toSafeHref('example.com:99999')).toBeNull();
    expect(toSafeHref('example.com:65536')).toBeNull();
  });

  it('returns null for something that cannot be a URL', () => {
    expect(toSafeHref('companyabc')).toBeNull();
    expect(toSafeHref('foo bar')).toBeNull();
  });
});
