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

import { guardianActionGate } from '@/services/guardian_action_gate';

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

  it('returns verified with the scope when the supplied otp checks out', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockResolvedValue(undefined);
    verifyGuardianOtp.mockResolvedValue(true);

    const result = await guardianActionGate({ ...baseInput, otp: '123456' });

    expect(result).toEqual({ status: 'verified', scope: EXPECTED_SCOPE });
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
});
