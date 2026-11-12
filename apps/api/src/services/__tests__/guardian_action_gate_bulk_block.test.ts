import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkConfigDocument } from '@dpg/schemas';

const { setting } = vi.hoisted(() => ({ setting: { enabled: true } }));
vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    apiConfig: {
      ...actual.apiConfig,
      get minor_bulk_actions_enabled() {
        return setting.enabled;
      },
    },
  };
});

const getNetworkConfigById = vi.fn();
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...args: unknown[]) => getNetworkConfigById(...args),
}));

const getWardAge = vi.fn();
const getGuardianContactPlaintext = vi.fn();
const getMinorGuardian = vi.fn();
vi.mock('@/services/minor_guardian_repo', () => ({
  getMinorGuardian: (...args: unknown[]) => getMinorGuardian(...args),
  getWardAge: (...args: unknown[]) => getWardAge(...args),
  getGuardianContactPlaintext: (...args: unknown[]) => getGuardianContactPlaintext(...args),
  getGuardianNamePlaintext: vi.fn(async () => 'Parent P'),
}));

vi.mock('@/notifications/resolve_owner', () => ({
  resolveProviderServiceName: vi.fn(async () => 'Acme'),
}));

const issueGuardianOtp = vi.fn();
const verifyGuardianOtp = vi.fn();
vi.mock('@/services/guardian_otp', () => ({
  issueGuardianOtp: (...args: unknown[]) => issueGuardianOtp(...args),
  verifyGuardianOtp: (...args: unknown[]) => verifyGuardianOtp(...args),
  assertVerifyAttemptAllowed: vi.fn(),
  GuardianOtpError: class extends Error {},
}));

import { guardianBulkActionGate, guardianGateFailure } from '@/services/guardian_action_gate';

const cfg = {
  id: 'purple_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
  ],
} as unknown as NetworkConfigDocument;

const row = (index: number, wardUserId = 'ward-1') => ({
  index,
  wardUserId,
  network: 'purple_dot',
  sourceDomain: 'seeker',
  actionType: 'connect',
  sourceItemId: 'src',
  targetItemId: `tgt-${index}`,
});

beforeEach(() => {
  vi.clearAllMocks();
  setting.enabled = true;
  getNetworkConfigById.mockResolvedValue(cfg);
  getWardAge.mockResolvedValue(15);
  getGuardianContactPlaintext.mockResolvedValue({ contact: '+919000000000', contactType: 'phone' });
  getMinorGuardian.mockResolvedValue({ guardianContactType: 'phone', guardianVerified: true });
  issueGuardianOtp.mockResolvedValue({ sentTo: '******0000' });
});

describe('guardianBulkActionGate with MINOR_BULK_ACTIONS_ENABLED=false (#917)', () => {
  it('blocks every gated row of a minor batch and sends no OTP', async () => {
    setting.enabled = false;
    const map = await guardianBulkActionGate({ items: [row(0), row(1), row(2)], stage: 'accept' });
    expect([0, 1, 2].map((i) => map.get(i))).toEqual([
      { status: 'minor_bulk_blocked' },
      { status: 'minor_bulk_blocked' },
      { status: 'minor_bulk_blocked' },
    ]);
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('blocks a batch even when it carries a guardian OTP', async () => {
    setting.enabled = false;
    const map = await guardianBulkActionGate({ items: [row(0), row(1)], otp: '123456' });
    expect(map.get(0)).toEqual({ status: 'minor_bulk_blocked' });
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('leaves a lone gated row to the per-action gate', async () => {
    for (const enabled of [false, true]) {
      setting.enabled = enabled;
      const map = await guardianBulkActionGate({ items: [row(0)] });
      expect(map.size).toBe(0);
    }
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('keeps the one-OTP batch when the guardian is on email', async () => {
    setting.enabled = false;
    getMinorGuardian.mockResolvedValue({ guardianContactType: 'email', guardianVerified: true });
    getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.co', contactType: 'email' });
    const map = await guardianBulkActionGate({ items: [row(0), row(1)] });
    expect(map.get(0)).toEqual({ status: 'challenge_issued', sentTo: '******0000' });
    expect(issueGuardianOtp).toHaveBeenCalledTimes(1);
  });

  it('blocks the batch when the guardian lookup fails', async () => {
    setting.enabled = false;
    getMinorGuardian.mockRejectedValue(new Error('db down'));
    const map = await guardianBulkActionGate({ items: [row(0), row(1)] });
    expect(map.get(0)).toEqual({ status: 'minor_bulk_blocked' });
    expect(map.get(1)).toEqual({ status: 'minor_bulk_blocked' });
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('leaves adults alone', async () => {
    setting.enabled = false;
    getWardAge.mockResolvedValue(30);
    const map = await guardianBulkActionGate({ items: [row(0), row(1)] });
    expect(map.size).toBe(0);
  });

  it('keeps the one-OTP batch when the setting is on', async () => {
    const map = await guardianBulkActionGate({ items: [row(0), row(1)] });
    expect(map.get(0)).toEqual({ status: 'challenge_issued', sentTo: '******0000' });
    expect(issueGuardianOtp).toHaveBeenCalledTimes(1);
  });
});

describe('guardianGateFailure', () => {
  it('maps minor_bulk_blocked to MINOR_BULK_ACTION_BLOCKED', () => {
    const failure = guardianGateFailure({ status: 'minor_bulk_blocked' });
    expect(failure?.errorCode).toBe('MINOR_BULK_ACTION_BLOCKED');
  });
});
