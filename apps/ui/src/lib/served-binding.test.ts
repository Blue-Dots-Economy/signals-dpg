import { describe, it, expect } from 'vitest';
import { parseServedBinding } from './served-binding';

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
