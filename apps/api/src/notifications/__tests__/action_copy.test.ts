import { describe, expect, it } from 'vitest';

import {
  FALLBACK_ACTION_COPY,
  FALLBACK_DOMAIN_LABEL,
  resolveActionCopy,
  resolveDomainLabel,
} from '../action_copy';

describe('resolveActionCopy', () => {
  it('returns connection-request copy for connect', () => {
    expect(resolveActionCopy('connect')).toEqual({
      objectNoun: 'connection request',
      inboundPhrase: 'wants to connect with you',
    });
  });

  it('returns application copy for apply', () => {
    expect(resolveActionCopy('apply').objectNoun).toBe('application');
  });

  it('maps pre_shortlist to the same copy as shortlist', () => {
    expect(resolveActionCopy('pre_shortlist')).toEqual(resolveActionCopy('shortlist'));
  });

  it('falls back gracefully for unknown action types', () => {
    expect(resolveActionCopy('totally_unknown')).toEqual(FALLBACK_ACTION_COPY);
  });
});

describe('resolveDomainLabel', () => {
  it('labels seeker', () => {
    expect(resolveDomainLabel('seeker')).toBe('a seeker');
  });

  it('labels provider', () => {
    expect(resolveDomainLabel('provider')).toBe('a service provider');
  });

  it('falls back for unknown domains', () => {
    expect(resolveDomainLabel('weird_domain')).toBe(FALLBACK_DOMAIN_LABEL);
  });
});
