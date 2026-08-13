import { describe, it, expect } from 'vitest';
import {
  SignupGuardianBodySchema,
  SignupGuardianVerifyBodySchema,
  U18GuardianBodySchema,
  U18ProfileConsentVerifyBodySchema,
  U18ProfilePrecreateVerifyBodySchema,
} from '../u18_consent';

const signupBase = {
  network: 'yellow_dot',
  domain: 'student',
  age: 15,
  guardianName: 'Meera',
  guardianDeclarationAccepted: true as const,
};

describe('SignupGuardianBodySchema — exactly-one signup identifier', () => {
  it('accepts an email-only signup', () => {
    const result = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      email: 'ward@example.com',
      guardianPhone: '9876543210',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a phone-only signup', () => {
    const result = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      phoneNumber: '9000000000',
      guardianEmail: 'meera@example.com',
    });
    expect(result.success).toBe(true);
  });

  it('rejects both identifiers at once', () => {
    const result = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      email: 'ward@example.com',
      phoneNumber: '9000000000',
      guardianPhone: '9876543210',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Exactly one of email or phoneNumber is required',
      );
      expect(result.error.issues[0].path).toEqual(['email']);
    }
  });

  it('rejects neither identifier', () => {
    const result = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      guardianPhone: '9876543210',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a signup with no guardian contact at all', () => {
    const result = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      email: 'ward@example.com',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages).toContain('Provide at least one guardian contact (email or phone)');
      expect(result.error.issues.map((i) => i.path)).toContainEqual(['guardianPhone']);
    }
  });

  it('rejects an unaccepted guardian declaration', () => {
    const result = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      guardianDeclarationAccepted: false,
      email: 'ward@example.com',
      guardianPhone: '9876543210',
    });
    expect(result.success).toBe(false);
  });

  it('coerces a numeric-string age and rejects an out-of-range one', () => {
    const ok = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      age: '17',
      email: 'ward@example.com',
      guardianPhone: '9876543210',
    });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.age).toBe(17);

    expect(
      SignupGuardianBodySchema.safeParse({
        ...signupBase,
        age: 121,
        email: 'ward@example.com',
        guardianPhone: '9876543210',
      }).success,
    ).toBe(false);
  });

  it('rejects a malformed signup email', () => {
    expect(
      SignupGuardianBodySchema.safeParse({
        ...signupBase,
        email: 'not-an-email',
        guardianPhone: '9876543210',
      }).success,
    ).toBe(false);
  });

  it('accepts an optional sameContactAcknowledged flag', () => {
    const result = SignupGuardianBodySchema.safeParse({
      ...signupBase,
      email: 'ward@example.com',
      guardianEmail: 'ward@example.com',
      sameContactAcknowledged: true,
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.sameContactAcknowledged).toBe(true);
  });
});

describe('SignupGuardianVerifyBodySchema', () => {
  it('accepts a 6-digit otp with exactly one identifier', () => {
    expect(
      SignupGuardianVerifyBodySchema.safeParse({ email: 'ward@example.com', otp: '123456' })
        .success,
    ).toBe(true);
    expect(
      SignupGuardianVerifyBodySchema.safeParse({ phoneNumber: '9000000000', otp: '123456' })
        .success,
    ).toBe(true);
  });

  it('rejects both identifiers', () => {
    const result = SignupGuardianVerifyBodySchema.safeParse({
      email: 'ward@example.com',
      phoneNumber: '9000000000',
      otp: '123456',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toBe(
        'Exactly one of email or phoneNumber is required',
      );
    }
  });

  it('rejects a missing identifier', () => {
    expect(SignupGuardianVerifyBodySchema.safeParse({ otp: '123456' }).success).toBe(false);
  });

  it('rejects an otp that is not exactly 6 characters', () => {
    expect(
      SignupGuardianVerifyBodySchema.safeParse({ email: 'ward@example.com', otp: '12345' })
        .success,
    ).toBe(false);
    expect(
      SignupGuardianVerifyBodySchema.safeParse({ email: 'ward@example.com', otp: '1234567' })
        .success,
    ).toBe(false);
  });

  it('treats network as optional on verify', () => {
    expect(
      SignupGuardianVerifyBodySchema.safeParse({ email: 'ward@example.com', otp: '123456' })
        .success,
    ).toBe(true);
  });
});

describe('U18GuardianBodySchema — session-scoped guardian consent', () => {
  const base = {
    network: 'yellow_dot',
    guardianName: 'Meera',
    guardianDeclarationAccepted: true as const,
  };

  it('accepts a guardian phone only', () => {
    expect(U18GuardianBodySchema.safeParse({ ...base, guardianPhone: '9876543210' }).success).toBe(
      true,
    );
  });

  it('accepts a guardian email only', () => {
    expect(
      U18GuardianBodySchema.safeParse({ ...base, guardianEmail: 'meera@example.com' }).success,
    ).toBe(true);
  });

  it('rejects when neither guardian contact is supplied', () => {
    const result = U18GuardianBodySchema.safeParse(base);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['guardianPhone']);
    }
  });

  it('accepts a null brand and rejects an empty-string brand', () => {
    expect(
      U18GuardianBodySchema.safeParse({ ...base, brand: null, guardianPhone: '9876543210' })
        .success,
    ).toBe(true);
    expect(
      U18GuardianBodySchema.safeParse({ ...base, brand: '', guardianPhone: '9876543210' }).success,
    ).toBe(false);
  });
});

describe('U18 item-scoped consent bodies', () => {
  const itemRef = {
    network: 'yellow_dot',
    item_domain: 'student',
    item_type: 'profile_1.0',
    item_id: '3f6f1b52-2a6f-4d2a-9d1a-1b0a9c7e5d21',
  };

  it('requires a uuid item_id plus a 6-char otp on the verify body', () => {
    expect(U18ProfileConsentVerifyBodySchema.safeParse({ ...itemRef, otp: '123456' }).success).toBe(
      true,
    );
    expect(
      U18ProfileConsentVerifyBodySchema.safeParse({ ...itemRef, item_id: 'nope', otp: '123456' })
        .success,
    ).toBe(false);
    expect(U18ProfileConsentVerifyBodySchema.safeParse(itemRef).success).toBe(false);
  });

  it('pre-create verify carries no item_id (the item does not exist yet)', () => {
    const result = U18ProfilePrecreateVerifyBodySchema.safeParse({
      network: 'yellow_dot',
      item_domain: 'student',
      otp: '123456',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('item_id' in result.data).toBe(false);
    }
  });
});
