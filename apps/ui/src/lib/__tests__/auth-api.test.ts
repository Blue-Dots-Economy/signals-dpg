import { describe, it, expect } from 'vitest';
import { normalizePhoneNumber, consentStatusIdentifier } from '../auth-api';

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
