import { describe, it, expect } from 'vitest';
import {
  U18DobBodySchema,
  U18GuardianBodySchema,
  U18GuardianVerifyBodySchema,
  U18ProfileConsentBodySchema,
  U18ProfileConsentVerifyBodySchema,
} from '../u18_consent';

describe('U18 consent request schemas', () => {
  it('accepts a valid DOB body and rejects month 13', () => {
    expect(U18DobBodySchema.safeParse({ network: 'blue_dot', birthYear: 2010, birthMonth: 6 }).success).toBe(true);
    expect(U18DobBodySchema.safeParse({ network: 'blue_dot', birthYear: 2010, birthMonth: 13 }).success).toBe(false);
  });

  it('requires guardianDeclarationAccepted === true and a valid contact type', () => {
    const base = { network: 'blue_dot', guardianName: 'P', guardianContact: 'a@b.co', guardianContactType: 'email' as const };
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: true }).success).toBe(true);
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: false }).success).toBe(false);
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianDeclarationAccepted: true, guardianContactType: 'whatsapp' }).success).toBe(false);
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
