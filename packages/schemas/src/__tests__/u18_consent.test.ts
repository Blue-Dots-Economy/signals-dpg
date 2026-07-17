import { describe, it, expect } from 'vitest';
import {
  U18DobBodySchema,
  U18GuardianBodySchema,
  U18GuardianVerifyBodySchema,
  U18ProfileConsentBodySchema,
  U18ProfileConsentVerifyBodySchema,
} from '../u18_consent';

describe('U18 consent request schemas', () => {
  it('accepts a full date of birth and rejects a non-date', () => {
    expect(U18DobBodySchema.safeParse({ network: 'blue_dot', dateOfBirth: '2010-06-15' }).success).toBe(true);
    expect(U18DobBodySchema.safeParse({ network: 'blue_dot', dateOfBirth: 'not-a-date' }).success).toBe(false);
    expect(U18DobBodySchema.safeParse({ network: 'blue_dot' }).success).toBe(false);
  });

  it('requires guardianDeclarationAccepted === true and at least one guardian contact', () => {
    const base = { network: 'blue_dot', guardianName: 'P', guardianEmail: 'a@b.co' };
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: true }).success).toBe(true);
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: false }).success).toBe(false);
    // Neither email nor phone → refine fails.
    expect(
      U18GuardianBodySchema.safeParse({ network: 'blue_dot', guardianName: 'P', guardianDeclarationAccepted: true }).success,
    ).toBe(false);
  });

  it('requires a 6-char otp', () => {
    expect(U18GuardianVerifyBodySchema.safeParse({ network: 'blue_dot', otp: '123456' }).success).toBe(true);
    expect(U18GuardianVerifyBodySchema.safeParse({ network: 'blue_dot', otp: '123' }).success).toBe(false);
  });

  it('profile-consent verify requires a 6-char otp + uuid item_id', () => {
    const base = { network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0', item_id: '11111111-1111-4111-8111-111111111111' };
    expect(U18ProfileConsentVerifyBodySchema.safeParse({ ...base, otp: '123456' }).success).toBe(true);
    expect(U18ProfileConsentVerifyBodySchema.safeParse({ ...base, otp: '12' }).success).toBe(false);
    expect(U18ProfileConsentBodySchema.safeParse({ ...base, item_id: 'not-uuid' }).success).toBe(false);
  });
});
