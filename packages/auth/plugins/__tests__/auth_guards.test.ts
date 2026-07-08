import { describe, it, expect } from 'vitest';
import {
  assertChannelAllowed,
  assertSelfSignupAllowed,
  isAdminDomainEmail,
} from '../auth_guards';

describe('assertChannelAllowed', () => {
  it('allows phone when phone is enabled', () => {
    expect(() => assertChannelAllowed({ phoneNumber: '+911234567890' }, ['phone'])).not.toThrow();
  });

  it('rejects phone when only email is enabled', () => {
    expect(() => assertChannelAllowed({ phoneNumber: '+911234567890' }, ['email'])).toThrow(
      /Phone login is not enabled/
    );
  });

  it('rejects email when only phone is enabled', () => {
    expect(() => assertChannelAllowed({ email: 'a@b.com' }, ['phone'])).toThrow(
      /Email login is not enabled/
    );
  });

  it('allows either when both enabled', () => {
    expect(() => assertChannelAllowed({ email: 'a@b.com' }, ['email', 'phone'])).not.toThrow();
    expect(() => assertChannelAllowed({ phoneNumber: '+911' }, ['email', 'phone'])).not.toThrow();
  });
});

describe('isAdminDomainEmail', () => {
  it('is true when the email domain is in adminByDomain', () => {
    expect(isAdminDomainEmail('x@sahamati.org.in', ['sahamati.org.in'])).toBe(true);
  });
  it('is false for a non-admin domain, missing email, or missing list', () => {
    expect(isAdminDomainEmail('x@other.com', ['sahamati.org.in'])).toBe(false);
    expect(isAdminDomainEmail(null, ['sahamati.org.in'])).toBe(false);
    expect(isAdminDomainEmail('x@a.com', undefined)).toBe(false);
  });
});

describe('assertSelfSignupAllowed', () => {
  it('passes when self-signup is allowed', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: true, email: 'x@y.com', adminByDomain: [] })
    ).not.toThrow();
  });

  it('throws SELF_SIGNUP_DISABLED when gated and not admin-domain', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: false, email: 'x@y.com', adminByDomain: ['admin.com'] })
    ).toThrow(/Self sign-up is disabled/);
  });

  it('exempts admin-domain emails even when gated', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: false, email: 'x@admin.com', adminByDomain: ['admin.com'] })
    ).not.toThrow();
  });

  it('throws when gated and identifier is phone-only (no email to exempt)', () => {
    expect(() =>
      assertSelfSignupAllowed({ allowSelfSignup: false, email: null, adminByDomain: ['admin.com'] })
    ).toThrow(/Self sign-up is disabled/);
  });
});
