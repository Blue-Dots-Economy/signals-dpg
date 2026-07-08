import { describe, it, expect } from 'vitest';
import { APIError } from 'better-auth/api';
import {
  assertChannelAllowed,
  assertSelfSignupAllowed,
  isAdminDomainEmail,
} from '../auth_guards';

/**
 * Runs `fn`, asserts it throws an `APIError` with the expected machine-readable
 * `code` (via `err.body.code`) and HTTP `status`, and returns the caught error
 * so callers can also assert on the message.
 */
function expectApiError(
  fn: () => void,
  expected: { code: string; status: string }
): APIError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(APIError);
    const apiError = err as APIError;
    expect(apiError.body?.code).toBe(expected.code);
    expect(apiError.status).toBe(expected.status);
    return apiError;
  }
  throw new Error('Expected function to throw an APIError, but it did not throw.');
}

describe('assertChannelAllowed', () => {
  it('allows phone when phone is enabled', () => {
    expect(() => assertChannelAllowed({ phoneNumber: '+911234567890' }, ['phone'])).not.toThrow();
  });

  it('rejects phone when only email is enabled', () => {
    expect(() => assertChannelAllowed({ phoneNumber: '+911234567890' }, ['email'])).toThrow(
      /Phone login is not enabled/
    );
    expectApiError(
      () => assertChannelAllowed({ phoneNumber: '+911234567890' }, ['email']),
      { code: 'LOGIN_CHANNEL_DISABLED', status: 'BAD_REQUEST' }
    );
  });

  it('rejects email when only phone is enabled', () => {
    expect(() => assertChannelAllowed({ email: 'a@b.com' }, ['phone'])).toThrow(
      /Email login is not enabled/
    );
    expectApiError(() => assertChannelAllowed({ email: 'a@b.com' }, ['phone']), {
      code: 'LOGIN_CHANNEL_DISABLED',
      status: 'BAD_REQUEST',
    });
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
    expectApiError(
      () =>
        assertSelfSignupAllowed({ allowSelfSignup: false, email: 'x@y.com', adminByDomain: ['admin.com'] }),
      { code: 'SELF_SIGNUP_DISABLED', status: 'FORBIDDEN' }
    );
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
    expectApiError(
      () => assertSelfSignupAllowed({ allowSelfSignup: false, email: null, adminByDomain: ['admin.com'] }),
      { code: 'SELF_SIGNUP_DISABLED', status: 'FORBIDDEN' }
    );
  });
});
