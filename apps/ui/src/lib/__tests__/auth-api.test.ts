import { describe, it, expect, vi } from 'vitest';
import { normalizePhoneNumber, consentStatusIdentifier, isValidPhoneNumber } from '../auth-api';

describe('isValidPhoneNumber', () => {
  it('accepts a bare 10-digit Indian mobile', () => {
    expect(isValidPhoneNumber('9620421129')).toBe(true);
  });
  it('accepts +91 with exactly 10 subscriber digits', () => {
    expect(isValidPhoneNumber('+919620421129')).toBe(true);
    expect(isValidPhoneNumber('+91 9620-421129')).toBe(true);
  });
  it('rejects a too-long +91 number', () => {
    expect(isValidPhoneNumber('+919620421129333')).toBe(false);
  });
  it('rejects +91 whose subscriber part starts below 6', () => {
    expect(isValidPhoneNumber('+915620421129')).toBe(false);
  });
  it('still accepts a generic non-91 E.164 number', () => {
    expect(isValidPhoneNumber('+14155552671')).toBe(true);
  });
  it('rejects empty / no-plus non-10-digit input', () => {
    expect(isValidPhoneNumber('')).toBe(false);
    expect(isValidPhoneNumber('12345')).toBe(false);
  });
});

describe('normalizePhoneNumber', () => {
  it('prepends +91 to a bare 10-digit Indian number', () => {
    expect(normalizePhoneNumber('9876543210')).toBe('+919876543210');
  });

  it('preserves an already-E.164 number', () => {
    expect(normalizePhoneNumber('+919876543210')).toBe('+919876543210');
  });

  it('prepends + to a country-code-prefixed number without +', () => {
    expect(normalizePhoneNumber('919876543210')).toBe('+919876543210');
  });

  it('strips spaces, dashes and parens before normalizing', () => {
    expect(normalizePhoneNumber('+91 98765-43210')).toBe('+919876543210');
    expect(normalizePhoneNumber('(987) 654-3210')).toBe('+919876543210');
  });
});

describe('consentStatusIdentifier', () => {
  it('normalizes the phone to E.164 so the pre-login consent lookup matches auth storage', () => {
    // Regression guard: the login-page consent check must send the same
    // canonical phone auth stores, or returning users are re-prompted for T&C.
    expect(consentStatusIdentifier({ phoneNumber: '9876543210' })).toEqual({
      phone: '+919876543210',
    });
  });

  it('passes the email through and omits an absent phone', () => {
    expect(consentStatusIdentifier({ email: 'a@b.com' })).toEqual({ email: 'a@b.com' });
  });

  it('handles both identifiers together', () => {
    expect(
      consentStatusIdentifier({ email: 'a@b.com', phoneNumber: '+919876543210' }),
    ).toEqual({ email: 'a@b.com', phone: '+919876543210' });
  });
});

describe('fetchAuthConfig', () => {
  it('GETs /api/v1/auth/config and returns the config', async () => {
    vi.resetModules();
    vi.doMock('../api-client', () => ({
      createApiClient: () => ({
        get: vi.fn().mockResolvedValue({
          data: { selfSignupAllowed: false, loginChannels: ['phone'] },
        }),
      }),
    }));
    const { fetchAuthConfig } = await import('../auth-api');
    await expect(fetchAuthConfig()).resolves.toEqual({
      selfSignupAllowed: false,
      loginChannels: ['phone'],
    });
  });
});
