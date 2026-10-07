import { describe, expect, it } from 'vitest';

import { resolveRecipientRole } from '../action_copy';

describe('resolveRecipientRole', () => {
  it('maps provider-like domains across networks to provider', () => {
    expect(resolveRecipientRole('provider')).toBe('provider');
    expect(resolveRecipientRole('coaching_center')).toBe('provider');
    expect(resolveRecipientRole('tutor')).toBe('provider');
    expect(resolveRecipientRole('practitioner')).toBe('provider');
  });
  it('treats seeker-like (and unknown) domains as seeker-facing', () => {
    expect(resolveRecipientRole('seeker')).toBe('seeker');
    expect(resolveRecipientRole('student')).toBe('seeker');
    expect(resolveRecipientRole('whatever')).toBe('seeker');
  });
});
