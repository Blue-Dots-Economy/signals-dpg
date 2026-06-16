import { describe, it, expect } from 'vitest';
import { parseServedBinding, parseServedScope } from './served-binding';

describe('parseServedBinding', () => {
  it('parses a valid network/domain pair', () => {
    expect(parseServedBinding('purple_dot/provider')).toEqual({
      network: 'purple_dot',
      domain: 'provider',
    });
  });
  it('trims surrounding whitespace', () => {
    expect(parseServedBinding('  purple_dot/seeker  ')).toEqual({
      network: 'purple_dot',
      domain: 'seeker',
    });
  });
  it.each([undefined, null, '', '   ', 'purple_dot', '/provider', 'purple_dot/', 'a/b/c'])(
    'returns null for malformed input %p',
    (input) => {
      expect(parseServedBinding(input as string | null | undefined)).toBeNull();
    },
  );
});

describe('parseServedScope', () => {
  it('parses a single binding into a one-domain scope', () => {
    expect(parseServedScope('purple_dot/provider')).toEqual({
      network: 'purple_dot',
      domains: ['provider'],
    });
  });
  it('parses a comma-separated list into a multi-domain scope', () => {
    expect(parseServedScope('yellow_dot/tutor, yellow_dot/coaching_center')).toEqual({
      network: 'yellow_dot',
      domains: ['tutor', 'coaching_center'],
    });
  });
  it('dedupes repeated domains', () => {
    expect(parseServedScope('purple_dot/provider,purple_dot/provider')).toEqual({
      network: 'purple_dot',
      domains: ['provider'],
    });
  });
  it('returns null when entries span multiple networks', () => {
    expect(parseServedScope('purple_dot/provider,blue_dot/seeker')).toBeNull();
  });
  it.each([undefined, null, '', '   ', 'purple_dot', 'purple_dot/provider,bad'])(
    'returns null for unset/malformed input %p',
    (input) => {
      expect(parseServedScope(input as string | null | undefined)).toBeNull();
    },
  );
});
