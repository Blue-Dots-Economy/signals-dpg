import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkConfigDocument } from '@dpg/schemas';

const getNetworkConfigById = vi.fn();
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...args: unknown[]) => getNetworkConfigById(...args),
}));

const getMinorGuardian = vi.fn();
const getWardAge = vi.fn();
const getGuardianContactPlaintext = vi.fn();
const getGuardianNamePlaintext = vi.fn();
vi.mock('@/services/minor_guardian_repo', () => ({
  getMinorGuardian: (...args: unknown[]) => getMinorGuardian(...args),
  getWardAge: (...args: unknown[]) => getWardAge(...args),
  getGuardianContactPlaintext: (...args: unknown[]) => getGuardianContactPlaintext(...args),
  getGuardianNamePlaintext: (...args: unknown[]) => getGuardianNamePlaintext(...args),
}));

const resolveProviderServiceName = vi.fn();
vi.mock('@/notifications/resolve_owner', () => ({
  resolveProviderServiceName: (...args: unknown[]) => resolveProviderServiceName(...args),
}));

// Codes the primitive raises; mirrors the real class shape so `instanceof`
// checks in the gate work against this mocked module. Defined via
// `vi.hoisted` so it exists before the hoisted `vi.mock` factory runs.
const { GuardianOtpError } = vi.hoisted(() => {
  class GuardianOtpError extends Error {
    constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER' | 'VERIFY_THROTTLED') {
      super(code);
      this.name = 'GuardianOtpError';
    }
  }
  return { GuardianOtpError };
});

const issueGuardianOtp = vi.fn();
const verifyGuardianOtp = vi.fn();
const assertVerifyAttemptAllowed = vi.fn();
vi.mock('@/services/guardian_otp', () => ({
  issueGuardianOtp: (...args: unknown[]) => issueGuardianOtp(...args),
  verifyGuardianOtp: (...args: unknown[]) => verifyGuardianOtp(...args),
  assertVerifyAttemptAllowed: (...args: unknown[]) => assertVerifyAttemptAllowed(...args),
  GuardianOtpError,
}));

import { guardianActionGate, guardianBulkActionGate, guardianGateFailure } from '@/services/guardian_action_gate';

const gatedCfg = {
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
  ],
} as unknown as NetworkConfigDocument;

const baseInput = {
  wardUserId: 'ward-1',
  network: 'blue_dot',
  sourceDomain: 'seeker',
  actionType: 'apply',
  sourceItemId: 'item-src',
  targetItemId: 'item-tgt',
  channel: 'self' as const,
};

const EXPECTED_SCOPE = 'guardian_action:ward-1:apply:item-src:item-tgt';

beforeEach(() => {
  vi.clearAllMocks();
  getNetworkConfigById.mockResolvedValue(gatedCfg);
  getGuardianNamePlaintext.mockResolvedValue('Parent P');
  resolveProviderServiceName.mockResolvedValue('Acme Services');
});

describe('guardianActionGate', () => {
  it('returns not_required when the source domain is ungated', async () => {
    const result = await guardianActionGate({ ...baseInput, sourceDomain: 'provider' });
    expect(result).toEqual({ status: 'not_required' });
    expect(getWardAge).not.toHaveBeenCalled();
  });

  it('returns not_required when gated but the ward is an adult (no minor_guardian row)', async () => {
    getWardAge.mockResolvedValue(null);
    const result = await guardianActionGate(baseInput);
    expect(result).toEqual({ status: 'not_required' });
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('returns not_required when gated but the ward is an adult (age says so)', async () => {
    getWardAge.mockResolvedValue(36);
    const result = await guardianActionGate(baseInput);
    expect(result).toEqual({ status: 'not_required' });
  });

  it('issues an OTP and returns challenge_issued for a gated minor with no otp supplied', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: '+911234', contactType: 'phone' });
    issueGuardianOtp.mockResolvedValue(undefined);

    const result = await guardianActionGate(baseInput);

    expect(result).toEqual({ status: 'challenge_issued' });
    expect(issueGuardianOtp).toHaveBeenCalledWith({
      scope: EXPECTED_SCOPE,
      contact: '+911234',
      contactType: 'phone',
      scenario: { kind: 'action', actionType: 'apply', stage: 'initiate' },
      variables: { parentName: 'Parent P', providerOrgName: 'Acme Services' },
    });
  });

  it('passes the network.json action type + stage through as the scenario', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.co', contactType: 'email' });
    issueGuardianOtp.mockResolvedValue(undefined);

    await guardianActionGate({ ...baseInput, actionType: 'connect', stage: 'accept' });

    expect(issueGuardianOtp).toHaveBeenCalledWith(
      expect.objectContaining({ scenario: { kind: 'action', actionType: 'connect', stage: 'accept' } }),
    );
  });

  it('returns verified when the supplied otp checks out (OTP scoped to the action)', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockResolvedValue(undefined);
    verifyGuardianOtp.mockResolvedValue(true);

    const result = await guardianActionGate({ ...baseInput, otp: '123456' });

    expect(result).toEqual({ status: 'verified' });
    expect(verifyGuardianOtp).toHaveBeenCalledWith({ scope: EXPECTED_SCOPE, otp: '123456' });
  });

  it('returns invalid_otp when the supplied otp is wrong', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockResolvedValue(undefined);
    verifyGuardianOtp.mockResolvedValue(false);

    const result = await guardianActionGate({ ...baseInput, otp: '000000' });

    expect(result).toEqual({ status: 'invalid_otp' });
  });

  it('returns throttled when verify attempts are exhausted', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockRejectedValue(new GuardianOtpError('VERIFY_THROTTLED'));

    const result = await guardianActionGate({ ...baseInput, otp: '123456' });

    expect(result).toEqual({ status: 'throttled' });
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('returns rate_limited when issuing throws RATE_LIMITED', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: '+911234', contactType: 'phone' });
    issueGuardianOtp.mockRejectedValue(new GuardianOtpError('RATE_LIMITED'));

    const result = await guardianActionGate(baseInput);

    expect(result).toEqual({ status: 'rate_limited' });
  });

  it('returns no_provider when issuing throws NO_OTP_PROVIDER', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: '+911234', contactType: 'phone' });
    issueGuardianOtp.mockRejectedValue(new GuardianOtpError('NO_OTP_PROVIDER'));

    const result = await guardianActionGate(baseInput);

    expect(result).toEqual({ status: 'no_provider' });
  });

  it('returns no_provider when the guardian has no contact on file', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue(null);

    const result = await guardianActionGate(baseInput);

    expect(result).toEqual({ status: 'no_provider' });
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  // External / on-behalf channel (#395): no guardian-OTP path over
  // voice/aggregator — a minor / age-unknown ward is blocked, an adult
  // proceeds unchanged, and an ungated domain short-circuits before age.
  describe('external channel', () => {
    const externalInput = { ...baseInput, channel: 'external' as const };

    it('blocks a gated minor with reason "minor"', async () => {
      getWardAge.mockResolvedValue(11);

      const result = await guardianActionGate(externalInput);

      expect(result).toEqual({ status: 'external_minor_blocked', reason: 'minor' });
      expect(issueGuardianOtp).not.toHaveBeenCalled();
    });

    it('blocks a gated age-unknown ward with reason "age_unknown" (fail-closed)', async () => {
      getWardAge.mockResolvedValue(null);

      const result = await guardianActionGate(externalInput);

      expect(result).toEqual({ status: 'external_minor_blocked', reason: 'age_unknown' });
      expect(issueGuardianOtp).not.toHaveBeenCalled();
    });

    it('lets a gated adult proceed (not_required)', async () => {
      getWardAge.mockResolvedValue(36);

      const result = await guardianActionGate(externalInput);

      expect(result).toEqual({ status: 'not_required' });
    });

    it('short-circuits to not_required on an ungated domain before checking age', async () => {
      const result = await guardianActionGate({ ...externalInput, sourceDomain: 'provider' });

      expect(result).toEqual({ status: 'not_required' });
      expect(getWardAge).not.toHaveBeenCalled();
    });
  });
});

describe('guardianGateFailure', () => {
  it('maps external_minor_blocked to MINOR_ACTION_CHANNEL_BLOCKED without leaking the reason', () => {
    const failure = guardianGateFailure({ status: 'external_minor_blocked', reason: 'age_unknown' });

    expect(failure).not.toBeNull();
    expect(failure!.errorCode).toBe('MINOR_ACTION_CHANNEL_BLOCKED');
    // The reason value never reaches the client-facing message.
    expect(failure!.message).not.toContain('age_unknown');
    expect(failure!.message).toBe(
      "This participant is a minor; actions for minors must be completed in the app and can't be performed via this channel.",
    );
  });

  it('returns null for not_required and verified', () => {
    expect(guardianGateFailure({ status: 'not_required' })).toBeNull();
    expect(guardianGateFailure({ status: 'verified', scope: 's' })).toBeNull();
  });
});

describe('guardianBulkActionGate (#393)', () => {
  const bulkItems = [
    { index: 0, wardUserId: 'ward-1', network: 'blue_dot', sourceDomain: 'seeker', actionType: 'apply', sourceItemId: 'src', targetItemId: 'tgt-a' },
    { index: 1, wardUserId: 'ward-1', network: 'blue_dot', sourceDomain: 'seeker', actionType: 'apply', sourceItemId: 'src', targetItemId: 'tgt-b' },
  ];

  it('issues ONE OTP listing every provider and challenges all gated items', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.co', contactType: 'email' });
    resolveProviderServiceName.mockImplementation((id: string) =>
      Promise.resolve(id === 'tgt-a' ? 'Acme' : 'Globex'),
    );
    issueGuardianOtp.mockResolvedValue(undefined);

    const map = await guardianBulkActionGate({ items: bulkItems });

    expect(issueGuardianOtp).toHaveBeenCalledTimes(1);
    const call = issueGuardianOtp.mock.calls[0][0];
    expect(call.scenario).toMatchObject({
      kind: 'action_bulk',
      actionType: 'apply',
      stage: 'initiate',
      providerOrgNames: ['Acme', 'Globex'],
      jobs: true,
    });
    expect(map.get(0)).toEqual({ status: 'challenge_issued' });
    expect(map.get(1)).toEqual({ status: 'challenge_issued' });
  });

  it('verifies the single OTP once and marks every gated item verified', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.co', contactType: 'email' });
    assertVerifyAttemptAllowed.mockResolvedValue(undefined);
    verifyGuardianOtp.mockResolvedValue(true);

    const map = await guardianBulkActionGate({ items: bulkItems, otp: '000000' });

    expect(verifyGuardianOtp).toHaveBeenCalledTimes(1);
    expect(map.get(0)).toMatchObject({ status: 'verified' });
    expect(map.get(1)).toMatchObject({ status: 'verified' });
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('returns invalid_otp for every gated item when the OTP is wrong', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.co', contactType: 'email' });
    assertVerifyAttemptAllowed.mockResolvedValue(undefined);
    verifyGuardianOtp.mockResolvedValue(false);

    const map = await guardianBulkActionGate({ items: bulkItems, otp: 'wrong' });

    expect(map.get(0)).toEqual({ status: 'invalid_otp' });
    expect(map.get(1)).toEqual({ status: 'invalid_otp' });
  });

  it('excludes ungated / adult items from the result map', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.co', contactType: 'email' });
    resolveProviderServiceName.mockResolvedValue('Acme');
    issueGuardianOtp.mockResolvedValue(undefined);

    const map = await guardianBulkActionGate({
      items: [
        bulkItems[0],
        // Ungated source domain → not gated → absent from the map.
        { index: 2, wardUserId: 'ward-1', network: 'blue_dot', sourceDomain: 'provider', actionType: 'connect', sourceItemId: 'src2', targetItemId: 'tgt-c' },
      ],
    });

    expect(map.has(0)).toBe(true);
    expect(map.has(2)).toBe(false);
  });
});
