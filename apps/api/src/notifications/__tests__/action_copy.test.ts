import { describe, expect, it } from 'vitest';

import {
  resolveActionEmailCopy,
  resolveCopyGroup,
  resolveRecipientRole,
} from '../action_copy';

describe('resolveCopyGroup', () => {
  it('maps connect to its own group', () => {
    expect(resolveCopyGroup('connect')).toBe('connect');
  });
  it('maps apply / shortlist / pre_shortlist to the apply family', () => {
    expect(resolveCopyGroup('apply')).toBe('apply');
    expect(resolveCopyGroup('shortlist')).toBe('apply');
    expect(resolveCopyGroup('pre_shortlist')).toBe('apply');
  });
});

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

describe('resolveActionEmailCopy (verbatim doc copy)', () => {
  it('connect / seeker / INBOUND_REQUEST', () => {
    expect(resolveActionEmailCopy('connect', 'seeker', 'INBOUND_REQUEST').subject).toBe(
      'A service provider wants to connect with you',
    );
  });
  it('connect / provider / INBOUND_REQUEST', () => {
    expect(resolveActionEmailCopy('connect', 'provider', 'INBOUND_REQUEST').subject).toBe(
      'A seeker wants to avail your service',
    );
  });
  it('apply / provider / INBOUND_REQUEST', () => {
    expect(resolveActionEmailCopy('apply', 'provider', 'INBOUND_REQUEST').subject).toBe(
      'A seeker has applied for your opportunity',
    );
  });
  it('apply / seeker / OUTBOUND_REQUEST uses the {name} token', () => {
    expect(resolveActionEmailCopy('apply', 'seeker', 'OUTBOUND_REQUEST').subject).toBe(
      'Your application has been sent to {name}',
    );
  });
});
