import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';

// --- mocks (hoisted) -------------------------------------------------------
// Every dependency of signup_guardian.ts is mocked: this is a pure unit test of
// the pre-auth guardian state machine (Redis-keyed pending record -> OTP verify
// -> materialize onto the freshly created user id).
const {
  redisGet,
  redisSet,
  redisTtl,
  redisDel,
  dbTransaction,
  tx,
  txInsertValues,
  getNetworkConfigById,
  isMinor,
  guardianConsentRequired,
  encryptGuardianField,
  guardianRef,
  issueGuardianOtp,
  verifyGuardianOtp,
  assertVerifyAttemptAllowed,
  resolveConsentVersion,
  guardianUserConsentRow,
  writeEncryptedGuardian,
  assertWardLimitWithLock,
  resolveOtpChannel,
  isGuardianWardLimitReached,
  guardianContactMatchesWard,
  setWardAge,
  served,
} = vi.hoisted(() => {
  const txInsertValuesFn = vi.fn();
  return {
    redisGet: vi.fn(),
    redisSet: vi.fn(),
    redisTtl: vi.fn(),
    redisDel: vi.fn(),
    dbTransaction: vi.fn(),
    tx: { insert: vi.fn(() => ({ values: txInsertValuesFn })) },
    txInsertValues: txInsertValuesFn,
    getNetworkConfigById: vi.fn(),
    isMinor: vi.fn(),
    guardianConsentRequired: vi.fn(),
    encryptGuardianField: vi.fn(),
    guardianRef: vi.fn(),
    issueGuardianOtp: vi.fn(),
    verifyGuardianOtp: vi.fn(),
    assertVerifyAttemptAllowed: vi.fn(),
    resolveConsentVersion: vi.fn(),
    guardianUserConsentRow: vi.fn(),
    writeEncryptedGuardian: vi.fn(),
    assertWardLimitWithLock: vi.fn(),
    resolveOtpChannel: vi.fn(),
    isGuardianWardLimitReached: vi.fn(),
    guardianContactMatchesWard: vi.fn(),
    setWardAge: vi.fn(),
    // Mutable so a test can change what the instance serves.
    served: { domains: [{ network: 'yellow_dot', domain: 'student' }] },
  };
});

vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    get: (...a: unknown[]) => redisGet(...a),
    set: (...a: unknown[]) => redisSet(...a),
    ttl: (...a: unknown[]) => redisTtl(...a),
    del: (...a: unknown[]) => redisDel(...a),
  },
}));

vi.mock('@api/db/postgres/drizzle_config', () => ({
  db: { transaction: (...a: unknown[]) => dbTransaction(...a) },
}));

vi.mock('@api/db/postgres/schema', () => ({
  consent_record: { userId: 'cr.userId' },
}));

vi.mock('@api/plugins/auth/auth_middleware', () => ({
  auth_middleware_if_enabled: async () => {},
}));

vi.mock('@/config', () => ({
  apiConfig: {
    get served_domains() {
      return served.domains;
    },
  },
}));

vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: unknown[]) => getNetworkConfigById(...a),
}));

vi.mock('@/services/minor', () => ({
  isMinor: (...a: unknown[]) => isMinor(...a),
  guardianConsentRequired: (...a: unknown[]) => guardianConsentRequired(...a),
}));

vi.mock('@/services/guardian_pii', () => ({
  encryptGuardianField: (...a: unknown[]) => encryptGuardianField(...a),
  guardianRef: (...a: unknown[]) => guardianRef(...a),
}));

vi.mock('@/services/guardian_otp', () => ({
  issueGuardianOtp: (...a: unknown[]) => issueGuardianOtp(...a),
  verifyGuardianOtp: (...a: unknown[]) => verifyGuardianOtp(...a),
  assertVerifyAttemptAllowed: (...a: unknown[]) => assertVerifyAttemptAllowed(...a),
}));

vi.mock('@/services/consent_version', () => ({
  resolveConsentVersion: (...a: unknown[]) => resolveConsentVersion(...a),
}));

vi.mock('@/services/guardian_consent_rows', () => ({
  guardianUserConsentRow: (...a: unknown[]) => guardianUserConsentRow(...a),
}));

vi.mock('@/services/minor_guardian_repo', () => ({
  writeEncryptedGuardian: (...a: unknown[]) => writeEncryptedGuardian(...a),
  assertWardLimitWithLock: (...a: unknown[]) => assertWardLimitWithLock(...a),
  resolveOtpChannel: (...a: unknown[]) => resolveOtpChannel(...a),
  isGuardianWardLimitReached: (...a: unknown[]) => isGuardianWardLimitReached(...a),
  guardianContactMatchesWard: (...a: unknown[]) => guardianContactMatchesWard(...a),
  setWardAge: (...a: unknown[]) => setWardAge(...a),
}));

// Imported AFTER the mocks.
const {
  startSignupGuardian,
  verifySignupGuardian,
  materializeSignupGuardian,
  SignupGuardianError,
} = await import('@/services/signup_guardian');

// --- helpers ---------------------------------------------------------------
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const pendingKeyFor = (v: string) => `signup_guardian:pending:${sha256(v)}`;
const otpScopeFor = (v: string) => `signup_guardian:${sha256(v)}`;

const WARD_EMAIL = 'ward@example.com';

function validStartInput(overrides: Record<string, unknown> = {}) {
  return {
    network: 'yellow_dot',
    domain: 'student',
    identifier: { email: WARD_EMAIL },
    age: 15,
    guardianName: 'Parent Name',
    guardianPhone: '+919900000000',
    guardianDeclarationAccepted: true as const,
    ...overrides,
  } as Parameters<typeof startSignupGuardian>[0];
}

/** The last JSON payload handed to redis.set, parsed. */
function lastPendingWritten(): Record<string, unknown> {
  const call = redisSet.mock.calls.at(-1);
  if (!call) throw new Error('redis.set was never called');
  return JSON.parse(call[1] as string) as Record<string, unknown>;
}

function verifiedPending(overrides: Record<string, unknown> = {}) {
  return {
    network: 'yellow_dot',
    domain: 'student',
    age: 15,
    guardianName: 'enc(Parent Name)',
    guardianContact: 'enc(+919900000000)',
    guardianContactType: 'phone',
    guardianRef: 'ref(+919900000000)',
    guardianPhone: 'enc(+919900000000)',
    guardianDeclarationAccepted: true,
    verified: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  served.domains = [{ network: 'yellow_dot', domain: 'student' }];

  getNetworkConfigById.mockResolvedValue({ id: 'yellow_dot' });
  guardianConsentRequired.mockReturnValue(true);
  isMinor.mockReturnValue(true);
  resolveOtpChannel.mockReturnValue({ contact: '+919900000000', contactType: 'phone' });
  isGuardianWardLimitReached.mockResolvedValue(false);
  guardianContactMatchesWard.mockReturnValue(false);
  encryptGuardianField.mockImplementation((v: unknown) => `enc(${String(v)})`);
  guardianRef.mockImplementation((v: unknown) => `ref(${String(v)})`);
  issueGuardianOtp.mockResolvedValue(undefined);
  verifyGuardianOtp.mockResolvedValue(true);
  assertVerifyAttemptAllowed.mockResolvedValue(undefined);
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue('OK');
  redisTtl.mockResolvedValue(1200);
  redisDel.mockResolvedValue(1);
  resolveConsentVersion.mockResolvedValue(3);
  guardianUserConsentRow.mockImplementation((args: unknown) => ({ row: args }));
  writeEncryptedGuardian.mockResolvedValue(undefined);
  assertWardLimitWithLock.mockResolvedValue(undefined);
  setWardAge.mockResolvedValue(undefined);
  txInsertValues.mockResolvedValue(undefined);
  dbTransaction.mockImplementation(
    async (fn: unknown) => await (fn as (t: unknown) => Promise<void>)(tx),
  );
});

// --- startSignupGuardian ---------------------------------------------------
describe('startSignupGuardian', () => {
  it('rejects a network/domain pair this instance does not serve', async () => {
    served.domains = [{ network: 'blue_dot', domain: 'student' }];

    await expect(startSignupGuardian(validStartInput())).rejects.toMatchObject({
      name: 'SignupGuardianError',
      code: 'UNKNOWN_NETWORK',
    });
    expect(getNetworkConfigById).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('rejects when the domain is not guardian-gated', async () => {
    guardianConsentRequired.mockReturnValue(false);

    await expect(startSignupGuardian(validStartInput())).rejects.toBeInstanceOf(
      SignupGuardianError,
    );
    await expect(startSignupGuardian(validStartInput())).rejects.toMatchObject({
      code: 'NOT_GATED',
    });
    expect(guardianConsentRequired).toHaveBeenCalledWith({ id: 'yellow_dot' }, 'student');
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('rejects an adult age', async () => {
    isMinor.mockReturnValue(false);

    await expect(startSignupGuardian(validStartInput({ age: 22 }))).rejects.toMatchObject({
      code: 'NOT_A_MINOR',
    });
    expect(isMinor).toHaveBeenCalledWith(22);
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('rejects when the guardian contact already has the maximum wards', async () => {
    isGuardianWardLimitReached.mockResolvedValue(true);

    await expect(startSignupGuardian(validStartInput())).rejects.toMatchObject({
      code: 'GUARDIAN_WARD_LIMIT',
    });
    // No ward id exists pre-auth, so all wards on the ref are counted.
    expect(isGuardianWardLimitReached).toHaveBeenCalledWith('+919900000000', null);
    expect(redisSet).not.toHaveBeenCalled();
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('hard-blocks a guardian contact equal to the ward signup identifier', async () => {
    guardianContactMatchesWard.mockReturnValue(true);

    await expect(
      startSignupGuardian(validStartInput({ sameContactAcknowledged: true })),
    ).rejects.toMatchObject({ code: 'SAME_CONTACT_NOT_ALLOWED' });
    // The ack is deliberately not honoured — the block is unconditional.
    expect(redisSet).not.toHaveBeenCalled();
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('compares the guardian contact against the normalized ward email only', async () => {
    await startSignupGuardian(
      validStartInput({
        identifier: { email: '  WARD@Example.COM ' },
        guardianEmail: 'g@example.com',
        guardianPhone: undefined,
      }),
    );

    expect(guardianContactMatchesWard).toHaveBeenCalledWith({
      wardEmail: WARD_EMAIL,
      wardPhone: null,
      guardianEmail: 'g@example.com',
      guardianPhone: undefined,
    });
  });

  it('passes the ward phone (not email) when signing up by phone', async () => {
    await startSignupGuardian(
      validStartInput({ identifier: { phoneNumber: ' +911234567890 ' } }),
    );

    expect(guardianContactMatchesWard).toHaveBeenCalledWith({
      wardEmail: null,
      wardPhone: '+911234567890',
      guardianEmail: undefined,
      guardianPhone: '+919900000000',
    });
    expect(redisSet.mock.calls[0]?.[0]).toBe(pendingKeyFor('+911234567890'));
  });

  it('stores the pending capture under a hash of the identifier with encrypted PII', async () => {
    await startSignupGuardian(
      validStartInput({ guardianEmail: 'g@example.com', guardianPhone: '+919900000000' }),
    );

    const [key, , exFlag, ttl] = redisSet.mock.calls[0] as [string, string, string, number];
    // The raw email must never appear in the Redis key.
    expect(key).toBe(pendingKeyFor(WARD_EMAIL));
    expect(key).not.toContain(WARD_EMAIL);
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(1800);

    expect(lastPendingWritten()).toEqual({
      network: 'yellow_dot',
      domain: 'student',
      age: 15,
      guardianName: 'enc(Parent Name)',
      guardianContact: 'enc(+919900000000)',
      guardianContactType: 'phone',
      guardianRef: 'ref(+919900000000)',
      guardianEmail: 'enc(g@example.com)',
      guardianPhone: 'enc(+919900000000)',
      guardianDeclarationAccepted: true,
      verified: false,
    });
  });

  it('omits guardianEmail/guardianPhone from the pending record when not supplied', async () => {
    resolveOtpChannel.mockReturnValue({ contact: 'g@example.com', contactType: 'email' });

    await startSignupGuardian(
      validStartInput({ guardianEmail: 'g@example.com', guardianPhone: undefined }),
    );

    const pending = lastPendingWritten();
    expect(pending.guardianEmail).toBe('enc(g@example.com)');
    expect(pending).not.toHaveProperty('guardianPhone');
    expect(pending.guardianContactType).toBe('email');
  });

  it('issues the OTP against the plaintext channel contact under a hashed scope', async () => {
    await startSignupGuardian(validStartInput());

    expect(issueGuardianOtp).toHaveBeenCalledWith({
      scope: otpScopeFor(WARD_EMAIL),
      contact: '+919900000000',
      contactType: 'phone',
      scenario: { kind: 'account' },
      variables: { parentName: 'Parent Name', domain: 'student' },
    });
    // Order matters: pending must exist before the OTP goes out.
    expect(redisSet.mock.invocationCallOrder[0]).toBeLessThan(
      issueGuardianOtp.mock.invocationCallOrder[0] as number,
    );
  });

  it('bubbles an OTP provider failure to the caller', async () => {
    issueGuardianOtp.mockRejectedValue(new Error('RATE_LIMITED'));

    await expect(startSignupGuardian(validStartInput())).rejects.toThrow('RATE_LIMITED');
  });
});

// --- verifySignupGuardian --------------------------------------------------
describe('verifySignupGuardian', () => {
  it('rejects when there is no pending capture for the identifier', async () => {
    redisGet.mockResolvedValue(null);

    await expect(
      verifySignupGuardian({ identifier: { email: WARD_EMAIL }, otp: '123456' }),
    ).rejects.toMatchObject({ code: 'NO_PENDING_SIGNUP' });
    expect(redisGet).toHaveBeenCalledWith(pendingKeyFor(WARD_EMAIL));
    expect(assertVerifyAttemptAllowed).not.toHaveBeenCalled();
  });

  it('treats an unparseable pending blob as no pending capture', async () => {
    redisGet.mockResolvedValue('{not-json');

    await expect(
      verifySignupGuardian({ identifier: { email: WARD_EMAIL }, otp: '123456' }),
    ).rejects.toMatchObject({ code: 'NO_PENDING_SIGNUP' });
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('enforces the verify-attempt throttle before checking the OTP', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending({ verified: false })));
    assertVerifyAttemptAllowed.mockRejectedValue(new Error('VERIFY_THROTTLED'));

    await expect(
      verifySignupGuardian({ identifier: { email: WARD_EMAIL }, otp: '123456' }),
    ).rejects.toThrow('VERIFY_THROTTLED');
    expect(assertVerifyAttemptAllowed).toHaveBeenCalledWith(otpScopeFor(WARD_EMAIL));
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('rejects a wrong OTP and leaves the pending record unverified', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending({ verified: false })));
    verifyGuardianOtp.mockResolvedValue(false);

    await expect(
      verifySignupGuardian({ identifier: { email: WARD_EMAIL }, otp: '000000' }),
    ).rejects.toMatchObject({ code: 'INVALID_OTP' });
    expect(verifyGuardianOtp).toHaveBeenCalledWith({
      scope: otpScopeFor(WARD_EMAIL),
      otp: '000000',
    });
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('flips verified=true and preserves the remaining TTL', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending({ verified: false })));
    redisTtl.mockResolvedValue(742);

    await verifySignupGuardian({ identifier: { email: `  ${WARD_EMAIL.toUpperCase()} ` }, otp: '123456' });

    const [key, , exFlag, ttl] = redisSet.mock.calls[0] as [string, string, string, number];
    // Identifier normalization means the uppercase/padded form hits the same key.
    expect(key).toBe(pendingKeyFor(WARD_EMAIL));
    expect(exFlag).toBe('EX');
    expect(ttl).toBe(742);
    expect(lastPendingWritten().verified).toBe(true);
    // Nothing is materialized here — that waits for the user row to exist.
    expect(dbTransaction).not.toHaveBeenCalled();
  });

  it('falls back to the default TTL when the key reports no expiry', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending({ verified: false })));
    redisTtl.mockResolvedValue(-1);

    await verifySignupGuardian({ identifier: { email: WARD_EMAIL }, otp: '123456' });

    expect(redisSet.mock.calls[0]?.[3]).toBe(1800);
  });
});

// --- materializeSignupGuardian --------------------------------------------
describe('materializeSignupGuardian', () => {
  it('is a no-op for a signup with no pending capture', async () => {
    redisGet.mockResolvedValue(null);

    await materializeSignupGuardian({ id: 'u1', email: WARD_EMAIL, phoneNumber: '+911234567890' });

    // Both identifiers are probed, nothing is written.
    expect(redisGet).toHaveBeenCalledTimes(2);
    expect(redisGet).toHaveBeenNthCalledWith(1, pendingKeyFor(WARD_EMAIL));
    expect(redisGet).toHaveBeenNthCalledWith(2, pendingKeyFor('+911234567890'));
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('ignores a pending capture whose OTP was never verified', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending({ verified: false })));

    await materializeSignupGuardian({ id: 'u1', email: WARD_EMAIL });

    expect(dbTransaction).not.toHaveBeenCalled();
    expect(writeEncryptedGuardian).not.toHaveBeenCalled();
    // The unverified record is left in place rather than deleted.
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('writes age, the already-encrypted guardian blobs and the three U18 consent rows', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending()));
    resolveConsentVersion
      .mockResolvedValueOnce(4) // guardian_declaration
      .mockResolvedValueOnce(2) // terms
      .mockResolvedValueOnce(7); // privacy

    await materializeSignupGuardian({ id: 'user-9', email: WARD_EMAIL });

    expect(assertWardLimitWithLock).toHaveBeenCalledWith(tx, 'ref(+919900000000)', 'user-9');
    expect(setWardAge).toHaveBeenCalledWith('user-9', 15, tx);
    expect(writeEncryptedGuardian).toHaveBeenCalledWith(
      'user-9',
      {
        guardianNameEnc: 'enc(Parent Name)',
        guardianContactEnc: 'enc(+919900000000)',
        guardianContactType: 'phone',
        guardianEmailEnc: null,
        guardianPhoneEnc: 'enc(+919900000000)',
        guardianRef: 'ref(+919900000000)',
      },
      tx,
    );
    // Nothing is re-encrypted on the way out of Redis.
    expect(encryptGuardianField).not.toHaveBeenCalled();

    const rows = (txInsertValues.mock.calls[0]?.[0] ?? []) as Array<{
      row: { category: string; source: string; documentVersion: number; userId: string };
    }>;
    expect(rows.map((r) => [r.row.category, r.row.source, r.row.documentVersion])).toEqual([
      ['guardian_declaration', 'self', 4],
      ['terms', 'guardian', 2],
      ['privacy', 'guardian', 7],
    ]);
    expect(rows.every((r) => r.row.userId === 'user-9')).toBe(true);

    // Replay protection: the pending key is dropped once materialized.
    expect(redisDel).toHaveBeenCalledWith(pendingKeyFor(WARD_EMAIL));
  });

  it('resolves every consent version as the u18 variant for the pending network', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending({ network: 'blue_dot' })));

    await materializeSignupGuardian({ id: 'u1', email: WARD_EMAIL });

    expect(resolveConsentVersion).toHaveBeenCalledTimes(3);
    for (const category of ['guardian_declaration', 'terms', 'privacy']) {
      expect(resolveConsentVersion).toHaveBeenCalledWith({
        network: 'blue_dot',
        category,
        variant: 'u18',
      });
    }
  });

  it('falls through to the phone identifier when the email has no verified capture', async () => {
    redisGet
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(JSON.stringify(verifiedPending()));

    await materializeSignupGuardian({ id: 'u1', email: WARD_EMAIL, phoneNumber: '+911234567890' });

    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(redisDel).toHaveBeenCalledWith(pendingKeyFor('+911234567890'));
  });

  it('stops after the first verified capture and never processes a second', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending()));

    await materializeSignupGuardian({ id: 'u1', email: WARD_EMAIL, phoneNumber: '+911234567890' });

    expect(redisGet).toHaveBeenCalledTimes(1);
    expect(dbTransaction).toHaveBeenCalledTimes(1);
    expect(redisDel).toHaveBeenCalledTimes(1);
  });

  it('throws and keeps the pending record when a u18 consent version is unconfigured', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending()));
    resolveConsentVersion.mockResolvedValueOnce(4).mockResolvedValueOnce(null).mockResolvedValueOnce(7);

    await expect(materializeSignupGuardian({ id: 'u1', email: WARD_EMAIL })).rejects.toThrow(
      /u18 consent versions are not fully configured for network "yellow_dot"/,
    );
    expect(dbTransaction).not.toHaveBeenCalled();
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('propagates the atomic ward-cap re-check failure without deleting the pending key', async () => {
    redisGet.mockResolvedValue(JSON.stringify(verifiedPending()));
    assertWardLimitWithLock.mockRejectedValue(new Error('GUARDIAN_WARD_LIMIT'));

    await expect(materializeSignupGuardian({ id: 'u1', email: WARD_EMAIL })).rejects.toThrow(
      'GUARDIAN_WARD_LIMIT',
    );
    expect(writeEncryptedGuardian).not.toHaveBeenCalled();
    expect(txInsertValues).not.toHaveBeenCalled();
    expect(redisDel).not.toHaveBeenCalled();
  });

  it('probes nothing when the new user has neither email nor phone', async () => {
    await materializeSignupGuardian({ id: 'u1', email: null, phoneNumber: null });

    expect(redisGet).not.toHaveBeenCalled();
    expect(dbTransaction).not.toHaveBeenCalled();
  });
});
