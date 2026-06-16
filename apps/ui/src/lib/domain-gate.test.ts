import { describe, it, expect } from 'vitest';
import { evaluateDomainGate } from './domain-gate';

describe('evaluateDomainGate', () => {
  it('allows a new user with no profiles', () => {
    expect(evaluateDomainGate([], 'provider')).toEqual({ allow: true });
  });
  it('allows a user whose profile is in the bound domain', () => {
    expect(evaluateDomainGate(['provider'], 'provider')).toEqual({ allow: true });
  });
  it('blocks a user whose profile is in another domain (names it)', () => {
    expect(evaluateDomainGate(['seeker'], 'provider')).toEqual({
      allow: false,
      heldDomain: 'seeker',
    });
  });
  it('blocks when any held domain differs from the bound domain', () => {
    expect(evaluateDomainGate(['provider', 'seeker'], 'provider')).toEqual({
      allow: false,
      heldDomain: 'seeker',
    });
  });
});
