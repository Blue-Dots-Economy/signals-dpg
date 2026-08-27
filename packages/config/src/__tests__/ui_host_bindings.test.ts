import { describe, expect, it } from 'vitest';

import { parseUiHostBindings, unknownBindingDomains } from '../ui_host_bindings';

describe('parseUiHostBindings', () => {
  it('inverts a multi-entry host binding string into domain -> origin', () => {
    const result = parseUiHostBindings(
      'bluedotssignals.provider.org=purple_dot/provider;bluedotssignals.seeker.org=purple_dot/seeker'
    );
    expect(result.byDomain).toEqual({
      provider: 'https://bluedotssignals.provider.org',
      seeker: 'https://bluedotssignals.seeker.org',
    });
    expect(result.warnings).toEqual([]);
  });

  it('returns an empty map for empty or undefined input', () => {
    expect(parseUiHostBindings('').byDomain).toEqual({});
    expect(parseUiHostBindings(undefined).byDomain).toEqual({});
    expect(parseUiHostBindings('').warnings).toEqual([]);
  });

  it('strips a single layer of Helm quote wrapping', () => {
    const result = parseUiHostBindings('"a.example.org=blue_dot/seeker"');
    expect(result.byDomain).toEqual({ seeker: 'https://a.example.org' });
  });

  it('honours an explicit http(s) scheme and port on the host', () => {
    const result = parseUiHostBindings(
      'http://localhost:5174=blue_dot/seeker;https://p.example.org:8443=blue_dot/provider'
    );
    expect(result.byDomain).toEqual({
      seeker: 'http://localhost:5174',
      provider: 'https://p.example.org:8443',
    });
    expect(result.warnings).toEqual([]);
  });

  it('skips an entry with no "=" separator and warns', () => {
    const result = parseUiHostBindings('justtext;a.example.org=blue_dot/seeker');
    expect(result.byDomain).toEqual({ seeker: 'https://a.example.org' });
    expect(result.warnings).toEqual([
      'UI_HOST_BINDINGS: skipping entry with no "=" separator: "justtext"',
    ]);
  });

  // A malformed entry drops out entirely (empty map) with exactly one warning.
  // The distinct reasons share one shape, so they are one parameterized test.
  it.each([
    {
      name: 'binding is not "network/domain"',
      input: 'a.example.org=seeker',
      warning:
        'UI_HOST_BINDINGS: skipping entry with invalid "network/domain" binding: "a.example.org=seeker"',
    },
    {
      name: 'host is invalid',
      input: '=blue_dot/seeker',
      warning: 'UI_HOST_BINDINGS: skipping entry with an invalid host: "=blue_dot/seeker"',
    },
    {
      name: 'host contains a path',
      input: 'a.example.org/x=blue_dot/seeker',
      warning:
        'UI_HOST_BINDINGS: skipping entry with an invalid host: "a.example.org/x=blue_dot/seeker"',
    },
  ])('skips an entry whose $name and warns', ({ input, warning }) => {
    const result = parseUiHostBindings(input);
    expect(result.byDomain).toEqual({});
    expect(result.warnings).toEqual([warning]);
  });

  it('keeps the FIRST host on a duplicate domain and warns', () => {
    const result = parseUiHostBindings(
      'canonical.example.org=blue_dot/seeker;vanity.example.org=blue_dot/seeker'
    );
    expect(result.byDomain).toEqual({ seeker: 'https://canonical.example.org' });
    expect(result.warnings).toEqual([
      'UI_HOST_BINDINGS: duplicate entry for domain "seeker" — the first one wins',
    ]);
  });

  it('accepts newline separators alongside semicolons', () => {
    const result = parseUiHostBindings('a.example.org=blue_dot/seeker\nb.example.org=blue_dot/provider');
    expect(Object.keys(result.byDomain).sort()).toEqual(['provider', 'seeker']);
  });
});

describe('unknownBindingDomains', () => {
  it('names keys that the served-domain list does not declare', () => {
    expect(unknownBindingDomains({ seekr: 'https://a', seeker: 'https://b' }, ['seeker', 'provider']))
      .toEqual(['seekr']);
  });

  it('returns an empty list when every key is known', () => {
    expect(unknownBindingDomains({ seeker: 'https://b' }, ['seeker', 'provider'])).toEqual([]);
  });
});
