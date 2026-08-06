import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- mocks (hoisted) -------------------------------------------------------
const { dbSelectRows, dbExecute, dbUpdateWhere, txInsert, dbTransaction } =
  vi.hoisted(() => ({
    dbSelectRows: [] as unknown[][],
    dbExecute: vi.fn(),
    dbUpdateWhere: vi.fn(),
    txInsert: vi.fn(),
    dbTransaction: vi.fn(),
  }));

function selectChain() {
  const rows = () => Promise.resolve(dbSelectRows.shift() ?? []);
  const whereResult = {
    then: (res: (v: unknown) => unknown) => rows().then(res),
    limit: () => rows(),
  };
  return { from: () => ({ where: () => whereResult }) };
}

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: {
    select: () => selectChain(),
    execute: (...a: unknown[]) => dbExecute(...a),
    update: () => ({ set: () => ({ where: (...a: unknown[]) => dbUpdateWhere(...a) }) }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => dbTransaction(fn),
  },
}));

vi.mock('@api/db/postgres/schema', () => ({
  minor_guardian: {
    userId: 'mg.userId',
    guardianRef: 'mg.guardianRef',
    guardianName: 'mg.guardianName',
    guardianContact: 'mg.guardianContact',
    guardianContactType: 'mg.guardianContactType',
    guardianVerified: 'mg.guardianVerified',
  },
  user: { id: 'user.id', age: 'user.age' },
}));

vi.mock('@/services/guardian_pii', () => ({
  encryptGuardianField: (v: string) => `enc(${v})`,
  decryptGuardianField: (v: string) => v.replace(/^enc\((.*)\)$/, '$1'),
  guardianRef: (contact: string) => `ref:${contact}`,
}));

vi.mock('@/config', () => ({ apiConfig: { max_wards_per_guardian: 3 } }));

vi.mock('@/services/minor', () => ({ isMinor: (age: number) => age < 18 }));

import {
  countWardsForGuardian,
  WardLimitError,
  assertWardLimitWithLock,
  isGuardianWardLimitReached,
  guardianContactMatchesWard,
  getWardAge,
  setWardAge,
  requireMinorWard,
  getMinorGuardian,
  resolveOtpChannel,
  upsertGuardianDetails,
  getGuardianContactPlaintext,
  getGuardianNamePlaintext,
  setGuardianVerified,
  writeEncryptedGuardian,
} from '../minor_guardian_repo';

beforeEach(() => {
  dbSelectRows.length = 0;
  vi.clearAllMocks();
});

describe('guardianContactMatchesWard', () => {
  it('matches email case-insensitively', () => {
    expect(
      guardianContactMatchesWard({
        wardEmail: 'Ward@Example.com',
        guardianEmail: 'ward@example.COM',
      }),
    ).toBe(true);
  });

  it('matches phone after trimming', () => {
    expect(
      guardianContactMatchesWard({
        wardPhone: ' 9990001111 ',
        guardianPhone: '9990001111',
      }),
    ).toBe(true);
  });

  it('false when contacts differ', () => {
    expect(
      guardianContactMatchesWard({
        wardEmail: 'a@x.com',
        wardPhone: '111',
        guardianEmail: 'b@x.com',
        guardianPhone: '222',
      }),
    ).toBe(false);
  });

  it('false when the ward has no contacts at all', () => {
    expect(
      guardianContactMatchesWard({
        guardianEmail: 'g@x.com',
        guardianPhone: '111',
      }),
    ).toBe(false);
  });

  it('false when the guardian side is absent', () => {
    expect(
      guardianContactMatchesWard({ wardEmail: 'a@x.com', wardPhone: '111' }),
    ).toBe(false);
  });

  it('an empty-string ward contact never matches', () => {
    expect(
      guardianContactMatchesWard({ wardEmail: '', guardianEmail: '' }),
    ).toBe(false);
  });

  it('true when either side matches (phone matches, email does not)', () => {
    expect(
      guardianContactMatchesWard({
        wardEmail: 'a@x.com',
        wardPhone: '111',
        guardianEmail: 'b@x.com',
        guardianPhone: '111',
      }),
    ).toBe(true);
  });
});

describe('resolveOtpChannel', () => {
  it('prefers phone when both contacts are supplied', () => {
    expect(
      resolveOtpChannel({ guardianEmail: 'g@x.com', guardianPhone: '111' }),
    ).toEqual({ contact: '111', contactType: 'phone' });
  });

  it('falls back to email when only email is supplied', () => {
    expect(resolveOtpChannel({ guardianEmail: 'g@x.com' })).toEqual({
      contact: 'g@x.com',
      contactType: 'email',
    });
  });

  it('throws when neither contact is supplied', () => {
    expect(() => resolveOtpChannel({})).toThrow(
      'at least one guardian contact is required',
    );
  });
});

describe('countWardsForGuardian', () => {
  it('returns the counted rows', async () => {
    dbSelectRows.push([{ n: 2 }]);

    await expect(countWardsForGuardian('ref:1', null)).resolves.toBe(2);
  });

  it('returns 0 when the count row is absent', async () => {
    dbSelectRows.push([]);

    await expect(countWardsForGuardian('ref:1', null)).resolves.toBe(0);
  });

  it('excludes the ward being re-linked when excludeUserId is given', async () => {
    dbSelectRows.push([{ n: 1 }]);

    await expect(countWardsForGuardian('ref:1', 'u1')).resolves.toBe(1);
  });
});

describe('assertWardLimitWithLock', () => {
  it('takes a transaction-scoped advisory lock BEFORE counting (closes the race)', async () => {
    dbSelectRows.push([{ n: 0 }]);
    const execute = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = { execute, select: () => selectChain() };

    await assertWardLimitWithLock(tx, 'ref:1', null);

    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('throws WardLimitError once the cap is reached', async () => {
    dbSelectRows.push([{ n: 3 }]); // cap is 3
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = { execute: vi.fn(), select: () => selectChain() };

    await expect(assertWardLimitWithLock(tx, 'ref:1', null)).rejects.toThrow(
      WardLimitError,
    );
  });

  it('passes when below the cap', async () => {
    dbSelectRows.push([{ n: 2 }]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = { execute: vi.fn(), select: () => selectChain() };

    await expect(
      assertWardLimitWithLock(tx, 'ref:1', null),
    ).resolves.toBeUndefined();
  });
});

describe('isGuardianWardLimitReached', () => {
  it('true at the cap', async () => {
    dbSelectRows.push([{ n: 3 }]);

    await expect(isGuardianWardLimitReached('g@x.com', null)).resolves.toBe(
      true,
    );
  });

  it('false below the cap', async () => {
    dbSelectRows.push([{ n: 1 }]);

    await expect(isGuardianWardLimitReached('g@x.com', null)).resolves.toBe(
      false,
    );
  });
});

describe('getWardAge / setWardAge', () => {
  it('returns the stored age', async () => {
    dbSelectRows.push([{ age: 15 }]);

    await expect(getWardAge('u1')).resolves.toBe(15);
  });

  it('returns null when no user row exists', async () => {
    dbSelectRows.push([]);

    await expect(getWardAge('u1')).resolves.toBeNull();
  });

  it('returns null when age is unset', async () => {
    dbSelectRows.push([{ age: null }]);

    await expect(getWardAge('u1')).resolves.toBeNull();
  });

  it('setWardAge issues the update', async () => {
    await setWardAge('u1', 16);

    expect(dbUpdateWhere).toHaveBeenCalledTimes(1);
  });
});

describe('requireMinorWard', () => {
  it('DOB_REQUIRED when no age is stored', async () => {
    dbSelectRows.push([]);

    await expect(requireMinorWard('u1')).resolves.toEqual({
      ok: false,
      code: 'DOB_REQUIRED',
    });
  });

  it('NOT_A_MINOR for an adult', async () => {
    dbSelectRows.push([{ age: 22 }]);

    await expect(requireMinorWard('u1')).resolves.toEqual({
      ok: false,
      code: 'NOT_A_MINOR',
    });
  });

  it('ok with the age for a minor', async () => {
    dbSelectRows.push([{ age: 15 }]);

    await expect(requireMinorWard('u1')).resolves.toEqual({ ok: true, age: 15 });
  });

  it('treats exactly 18 as not a minor', async () => {
    dbSelectRows.push([{ age: 18 }]);

    await expect(requireMinorWard('u1')).resolves.toEqual({
      ok: false,
      code: 'NOT_A_MINOR',
    });
  });
});

describe('getMinorGuardian', () => {
  it('returns null when no guardian row exists', async () => {
    dbSelectRows.push([]);

    await expect(getMinorGuardian('u1')).resolves.toBeNull();
  });

  it('returns the contact type and verified flag', async () => {
    dbSelectRows.push([
      { guardianContactType: 'phone', guardianVerified: true },
    ]);

    await expect(getMinorGuardian('u1')).resolves.toEqual({
      guardianContactType: 'phone',
      guardianVerified: true,
    });
  });

  it('normalises a missing contact type to null', async () => {
    dbSelectRows.push([
      { guardianContactType: null, guardianVerified: false },
    ]);

    await expect(getMinorGuardian('u1')).resolves.toEqual({
      guardianContactType: null,
      guardianVerified: false,
    });
  });
});

describe('upsertGuardianDetails', () => {
  it('encrypts name and contacts, resets verified, and enforces the cap in-transaction', async () => {
    dbSelectRows.push([{ n: 0 }]);
    const onConflictDoUpdate = vi.fn();
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    txInsert.mockReturnValue({ values });
    dbTransaction.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fn: (tx: any) => Promise<unknown>) =>
        fn({
          execute: vi.fn(),
          select: () => selectChain(),
          insert: txInsert,
        }),
    );

    await upsertGuardianDetails('u1', {
      guardianName: 'Guard Ian',
      guardianEmail: 'g@x.com',
      guardianPhone: '111',
    });

    const written = values.mock.calls[0][0] as Record<string, unknown>;
    expect(written.guardianName).toBe('enc(Guard Ian)');
    // Phone preferred as the OTP channel when both are supplied.
    expect(written.guardianContact).toBe('enc(111)');
    expect(written.guardianContactType).toBe('phone');
    expect(written.guardianEmail).toBe('enc(g@x.com)');
    expect(written.guardianPhone).toBe('enc(111)');
    expect(written.guardianVerified).toBe(false);
  });

  it('stores null for a contact the guardian did not supply', async () => {
    dbSelectRows.push([{ n: 0 }]);
    const onConflictDoUpdate = vi.fn();
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    txInsert.mockReturnValue({ values });
    dbTransaction.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fn: (tx: any) => Promise<unknown>) =>
        fn({
          execute: vi.fn(),
          select: () => selectChain(),
          insert: txInsert,
        }),
    );

    await upsertGuardianDetails('u1', {
      guardianName: 'G',
      guardianEmail: 'g@x.com',
    });

    const written = values.mock.calls[0][0] as Record<string, unknown>;
    expect(written.guardianPhone).toBeNull();
    expect(written.guardianContactType).toBe('email');
  });

  it('propagates WardLimitError from the in-transaction cap check', async () => {
    dbSelectRows.push([{ n: 3 }]);
    dbTransaction.mockImplementation(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fn: (tx: any) => Promise<unknown>) =>
        fn({
          execute: vi.fn(),
          select: () => selectChain(),
          insert: txInsert,
        }),
    );

    await expect(
      upsertGuardianDetails('u1', { guardianName: 'G', guardianPhone: '111' }),
    ).rejects.toThrow(WardLimitError);
  });
});

describe('getGuardianContactPlaintext', () => {
  it('decrypts the stored contact', async () => {
    dbSelectRows.push([
      { guardianContact: 'enc(111)', guardianContactType: 'phone' },
    ]);

    await expect(getGuardianContactPlaintext('u1')).resolves.toEqual({
      contact: '111',
      contactType: 'phone',
    });
  });

  it('returns null when no row exists', async () => {
    dbSelectRows.push([]);

    await expect(getGuardianContactPlaintext('u1')).resolves.toBeNull();
  });

  it('returns null when the contact is missing', async () => {
    dbSelectRows.push([
      { guardianContact: null, guardianContactType: 'phone' },
    ]);

    await expect(getGuardianContactPlaintext('u1')).resolves.toBeNull();
  });

  it('returns null when the contact type is missing', async () => {
    dbSelectRows.push([
      { guardianContact: 'enc(111)', guardianContactType: null },
    ]);

    await expect(getGuardianContactPlaintext('u1')).resolves.toBeNull();
  });
});

describe('getGuardianNamePlaintext', () => {
  it('decrypts the stored name', async () => {
    dbSelectRows.push([{ guardianName: 'enc(Guard Ian)' }]);

    await expect(getGuardianNamePlaintext('u1')).resolves.toBe('Guard Ian');
  });

  it('returns null when absent', async () => {
    dbSelectRows.push([{ guardianName: null }]);

    await expect(getGuardianNamePlaintext('u1')).resolves.toBeNull();
  });
});

describe('setGuardianVerified', () => {
  it('issues the update', async () => {
    await setGuardianVerified('u1');

    expect(dbUpdateWhere).toHaveBeenCalledTimes(1);
  });
});

describe('writeEncryptedGuardian', () => {
  it('writes the pre-encrypted blob verbatim and marks verified true', async () => {
    const onConflictDoUpdate = vi.fn();
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec: any = { insert: () => ({ values }) };

    await writeEncryptedGuardian(
      'u1',
      {
        guardianNameEnc: 'ALREADY_ENC_NAME',
        guardianContactEnc: 'ALREADY_ENC_CONTACT',
        guardianContactType: 'email',
        guardianRef: 'ref:g@x.com',
      },
      exec,
    );

    const written = values.mock.calls[0][0] as Record<string, unknown>;
    // No re-encryption: the pre-auth signup flow already encrypted these.
    expect(written.guardianName).toBe('ALREADY_ENC_NAME');
    expect(written.guardianContact).toBe('ALREADY_ENC_CONTACT');
    expect(written.guardianVerified).toBe(true);
    expect(written.guardianRef).toBe('ref:g@x.com');
  });

  it('defaults the optional encrypted contacts and ref to null', async () => {
    const onConflictDoUpdate = vi.fn();
    const values = vi.fn(() => ({ onConflictDoUpdate }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exec: any = { insert: () => ({ values }) };

    await writeEncryptedGuardian(
      'u1',
      {
        guardianNameEnc: 'N',
        guardianContactEnc: 'C',
        guardianContactType: 'phone',
      },
      exec,
    );

    const written = values.mock.calls[0][0] as Record<string, unknown>;
    expect(written.guardianEmail).toBeNull();
    expect(written.guardianPhone).toBeNull();
    expect(written.guardianRef).toBeNull();
  });
});
