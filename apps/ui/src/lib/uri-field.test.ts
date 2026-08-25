import { describe, it, expect } from 'vitest';
import { toSafeHref } from './uri-field';

describe('toSafeHref', () => {
  it('passes http and https through unchanged', () => {
    expect(toSafeHref('https://example.com/x')).toBe('https://example.com/x');
    expect(toSafeHref('http://example.com')).toBe('http://example.com/');
  });

  it('prefixes https:// on a scheme-less host', () => {
    expect(toSafeHref('example.com')).toBe('https://example.com/');
    expect(toSafeHref('www.example.com/a')).toBe('https://www.example.com/a');
  });

  it('prefixes https:// on a scheme-less host:port, not mistaken for an explicit scheme', () => {
    expect(toSafeHref('example.com:8080')).toBe('https://example.com:8080/');
    expect(toSafeHref('mysite.io:8080/path')).toBe('https://mysite.io:8080/path');
  });

  it('trims surrounding whitespace', () => {
    expect(toSafeHref('  example.com  ')).toBe('https://example.com/');
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

  it('refuses userinfo, which would let the link lie about its destination', () => {
    // `https://<looks-trustworthy>@evil.example/` opens evil.example — everything
    // before the `@` is a username. The display text is head-truncated, so a long
    // enough userinfo hides the real host entirely. URL_PATTERN rejects `@`, but
    // this is the last line for values it never saw (required fields skip server
    // validation, pre-existing values are never re-checked, an author `pattern`
    // replaces ours).
    expect(
      toSafeHref('https://www.trusted-national-skills-verification-portal.gov.in@evil.example/apply'),
    ).toBeNull();
    expect(toSafeHref('https://user:pw@evil.example/x')).toBeNull();
    expect(toSafeHref('http://admin@evil.example')).toBeNull();
  });

  it('returns the parsed URL, so the href matches what was validated', () => {
    // The checks run on the parsed form; returning the raw string left a gap
    // (`//evil.com` became `https:////evil.com`). Same destination either way —
    // browsers normalise — but now the two agree.
    expect(toSafeHref('//evil.com')).toBe('https://evil.com/');
    expect(toSafeHref('https://example.com\\..\\x')).toBe('https://example.com/x');
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
