import { describe, it, expect } from 'vitest';
import { resolveDomainLock } from '../resolve_domain_lock';

describe('resolveDomainLock', () => {
  it('allows any domain when the user holds no items yet', () => {
    expect(resolveDomainLock([], 'seeker')).toEqual({
      allowed: true,
      lockedDomain: null,
    });
  });

  it('allows creating in the domain the user already holds', () => {
    expect(resolveDomainLock(['provider'], 'provider')).toEqual({
      allowed: true,
      lockedDomain: 'provider',
    });
  });

  it('denies a different domain than the one held', () => {
    expect(resolveDomainLock(['seeker'], 'provider')).toEqual({
      allowed: false,
      lockedDomain: 'seeker',
    });
  });

  it('deduplicates repeated domains (multiple items, one domain)', () => {
    expect(resolveDomainLock(['provider', 'provider'], 'provider')).toEqual({
      allowed: true,
      lockedDomain: 'provider',
    });
  });

  it('tolerates legacy dirty data spanning two domains by allowing any held domain', () => {
    expect(resolveDomainLock(['seeker', 'provider'], 'provider')).toEqual({
      allowed: true,
      lockedDomain: 'seeker',
    });
    expect(resolveDomainLock(['seeker', 'provider'], 'student').allowed).toBe(false);
  });
});
