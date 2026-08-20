import { describe, it, expect } from 'vitest';
import { resolveMyItemsDomainId } from '../sidebar';

describe('resolveMyItemsDomainId', () => {
  it('uses the served domain when the viewer has no profiles yet', () => {
    // The signed-out case this fixes: a provider portal knows its domain from
    // VITE_SERVED_BINDINGS, so it can title the group "My Jobs" rather than
    // the generic "My Profile(s)".
    expect(resolveMyItemsDomainId([], ['provider'])).toBe('provider');
  });

  it("prefers the viewer's own domain over the portal binding", () => {
    // A viewer holding items is the stronger signal, and the two can disagree
    // while a mis-routed user is being bounced to the right portal.
    expect(resolveMyItemsDomainId(['seeker'], ['provider'])).toBe('seeker');
  });

  it('falls back to the generic label when the viewer spans domains', () => {
    expect(resolveMyItemsDomainId(['seeker', 'provider'], ['provider'])).toBeNull();
  });

  it('falls back to the generic label on a multi-domain portal', () => {
    expect(resolveMyItemsDomainId([], ['seeker', 'provider'])).toBeNull();
  });

  it('falls back to the generic label when nothing is bound', () => {
    expect(resolveMyItemsDomainId([], null)).toBeNull();
    expect(resolveMyItemsDomainId([], [])).toBeNull();
  });
});
