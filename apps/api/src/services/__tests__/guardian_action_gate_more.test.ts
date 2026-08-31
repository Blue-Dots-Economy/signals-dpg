import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkConfigDocument } from '@dpg/schemas';

// Gap-closing companion to guardian_action_gate.test.ts (#393/#395): the error
// re-throw paths, the per-bucket `continue` paths of the bulk gate, the
// caching/grouping behaviour, the sha256 batch scope, the isMinor boundary and
// the remaining guardianGateFailure mappings.

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

// Mirrors the real error class so the gate's `instanceof` checks hold against
// the mocked module. Hoisted so it exists before the vi.mock factory runs.
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

// The real guardian_otp primitives are exercised at the bottom of this file via
// vi.importActual; they need redis + config stubbed out.
const redisStore = new Map<string, string>();
vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    get: vi.fn(async (k: string) => redisStore.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      redisStore.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      redisStore.delete(k);
      return 1;
    }),
    incr: vi.fn(async (k: string) => {
      const n = Number(redisStore.get(k) ?? '0') + 1;
      redisStore.set(k, String(n));
      return n;
    }),
    expire: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, arg: string) => {
      if (redisStore.get(key) === arg) {
        redisStore.delete(key);
        return 1;
      }
      return 0;
    }),
  },
}));

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return { ...actual, authConfig: { ...actual.authConfig, create_test_otp: false } };
});

import {
  guardianActionGate,
  guardianBulkActionGate,
  guardianGateFailure,
  type BulkGateItem,
} from '@/services/guardian_action_gate';

const gatedCfgFor = (id: string) =>
  ({
    id,
    domains: [
      { id: 'seeker', guardian_consent_required: true },
      { id: 'provider', guardian_consent_required: false },
    ],
  }) as unknown as NetworkConfigDocument;

const baseInput = {
  wardUserId: 'ward-1',
  network: 'blue_dot',
  sourceDomain: 'seeker',
  actionType: 'apply',
  sourceItemId: 'item-src',
  targetItemId: 'item-tgt',
  channel: 'self' as const,
};

const bulkItem = (over: Partial<BulkGateItem> & { index: number }): BulkGateItem => ({
  wardUserId: 'ward-1',
  network: 'blue_dot',
  sourceDomain: 'seeker',
  actionType: 'apply',
  sourceItemId: 'src',
  targetItemId: 'tgt',
  ...over,
});

/**
 * Re-implements the gate's documented scope rule: sha256 of the SORTED tuples.
 * Sorted by code point (not `localeCompare`) — the hash has to be identical
 * across processes and locales for the guardian's one OTP to re-match.
 */
const expectedBulkScope = (ward: string, network: string, tuples: string[]) =>
  `guardian_action_bulk:${ward}:${network}:` +
  createHash('sha256')
    .update([...tuples].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(','))
    .digest('hex');

beforeEach(() => {
  vi.clearAllMocks();
  redisStore.clear();
  getNetworkConfigById.mockImplementation((id: string) => Promise.resolve(gatedCfgFor(id)));
  getGuardianNamePlaintext.mockResolvedValue('Parent P');
  resolveProviderServiceName.mockResolvedValue('Acme Services');
  getGuardianContactPlaintext.mockResolvedValue({ contact: 'g@x.co', contactType: 'email' });
});

describe('guardianActionGate — error propagation (fail-closed, never silently proceeds)', () => {
  it('re-throws a non-GuardianOtpError raised while issuing (no accidental not_required)', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockRejectedValue(new Error('notifier exploded'));

    await expect(guardianActionGate(baseInput)).rejects.toThrow('notifier exploded');
  });

  it('re-throws a GuardianOtpError from the verify throttle that is not VERIFY_THROTTLED', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockRejectedValue(new GuardianOtpError('RATE_LIMITED'));

    await expect(guardianActionGate({ ...baseInput, otp: '123456' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('re-throws a plain error from the verify throttle', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockRejectedValue(new Error('redis down'));

    await expect(guardianActionGate({ ...baseInput, otp: '123456' })).rejects.toThrow('redis down');
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });
});

describe('guardianActionGate — template variables and the u18 boundary', () => {
  it('omits parentName/providerOrgName entirely when both lookups return null', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianNamePlaintext.mockResolvedValue(null);
    resolveProviderServiceName.mockResolvedValue(null);
    issueGuardianOtp.mockResolvedValue(undefined);

    const result = await guardianActionGate(baseInput);

    expect(result).toEqual({ status: 'challenge_issued' });
    expect(issueGuardianOtp.mock.calls[0][0].variables).toEqual({});
  });

  it('still issues an OTP when only one of the two template lookups resolves', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianNamePlaintext.mockResolvedValue(null);
    resolveProviderServiceName.mockResolvedValue('Globex');
    issueGuardianOtp.mockResolvedValue(undefined);

    await guardianActionGate(baseInput);

    expect(issueGuardianOtp.mock.calls[0][0].variables).toEqual({ providerOrgName: 'Globex' });
  });

  it('treats age 18 as a minor (whole boundary year is gated) and 19 as an adult', async () => {
    issueGuardianOtp.mockResolvedValue(undefined);

    getWardAge.mockResolvedValue(18);
    expect(await guardianActionGate(baseInput)).toEqual({ status: 'challenge_issued' });

    getWardAge.mockResolvedValue(19);
    expect(await guardianActionGate(baseInput)).toEqual({ status: 'not_required' });
  });

  it('blocks an 18-year-old on the external channel and lets a 19-year-old through', async () => {
    const external = { ...baseInput, channel: 'external' as const };

    getWardAge.mockResolvedValue(18);
    expect(await guardianActionGate(external)).toEqual({
      status: 'external_minor_blocked',
      reason: 'minor',
    });

    getWardAge.mockResolvedValue(19);
    expect(await guardianActionGate(external)).toEqual({ status: 'not_required' });
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });
});

describe('guardianBulkActionGate — batch scope (#393)', () => {
  it('hashes the SORTED tuple set, so resubmitting the same batch reordered re-uses one scope', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockResolvedValue(undefined);

    const a = bulkItem({ index: 0, targetItemId: 'tgt-a' });
    const b = bulkItem({ index: 1, targetItemId: 'tgt-b' });

    await guardianBulkActionGate({ items: [a, b] });
    await guardianBulkActionGate({ items: [{ ...b, index: 0 }, { ...a, index: 1 }] });

    const expected = expectedBulkScope('ward-1', 'blue_dot', [
      'apply|src|tgt-a',
      'apply|src|tgt-b',
    ]);
    expect(issueGuardianOtp.mock.calls[0][0].scope).toBe(expected);
    expect(issueGuardianOtp.mock.calls[1][0].scope).toBe(expected);
  });

  it('sorts tuples by code point, not locale collation, so the scope is locale-stable', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockResolvedValue(undefined);

    await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, actionType: 'apply' }),
        bulkItem({ index: 1, actionType: 'Bookmark' }),
      ],
    });

    // 'B' (0x42) < 'a' (0x61) by code point, so 'Bookmark|…' leads. A
    // `localeCompare` sort would put 'apply|…' first and change the digest —
    // and with it the Redis scope the guardian's OTP is stored under.
    const expected =
      'guardian_action_bulk:ward-1:blue_dot:' +
      createHash('sha256').update('Bookmark|src|tgt,apply|src|tgt').digest('hex');
    expect(issueGuardianOtp.mock.calls[0][0].scope).toBe(expected);
  });

  it('produces a different scope when the batch membership changes', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockResolvedValue(undefined);

    await guardianBulkActionGate({ items: [bulkItem({ index: 0, targetItemId: 'tgt-a' })] });
    await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, targetItemId: 'tgt-a' }),
        bulkItem({ index: 1, targetItemId: 'tgt-b' }),
      ],
    });

    expect(issueGuardianOtp.mock.calls[0][0].scope).not.toBe(
      issueGuardianOtp.mock.calls[1][0].scope,
    );
  });
});

describe('guardianBulkActionGate — grouping, caching and gating decisions', () => {
  it('buckets per ward+network: one OTP each, with a scope covering only that ward’s tuples', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockResolvedValue(undefined);

    const map = await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, wardUserId: 'ward-1', targetItemId: 'tgt-a' }),
        bulkItem({ index: 1, wardUserId: 'ward-2', targetItemId: 'tgt-b' }),
        bulkItem({ index: 2, wardUserId: 'ward-1', network: 'yellow_dot', targetItemId: 'tgt-c' }),
      ],
    });

    expect(issueGuardianOtp).toHaveBeenCalledTimes(3);
    const scopes = issueGuardianOtp.mock.calls.map((c) => c[0].scope);
    expect(scopes).toContain(expectedBulkScope('ward-1', 'blue_dot', ['apply|src|tgt-a']));
    expect(scopes).toContain(expectedBulkScope('ward-2', 'blue_dot', ['apply|src|tgt-b']));
    expect(scopes).toContain(expectedBulkScope('ward-1', 'yellow_dot', ['apply|src|tgt-c']));
    expect([...map.keys()].sort()).toEqual([0, 1, 2]);
  });

  it('resolves the network config once per network and the age once per ward', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockResolvedValue(undefined);

    await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, targetItemId: 'tgt-a' }),
        bulkItem({ index: 1, targetItemId: 'tgt-b' }),
        bulkItem({ index: 2, targetItemId: 'tgt-c' }),
      ],
    });

    expect(getNetworkConfigById).toHaveBeenCalledTimes(1);
    expect(getWardAge).toHaveBeenCalledTimes(1);
  });

  it('caches a null age too (no repeat lookup) and leaves the ward’s items out of the map', async () => {
    getWardAge.mockResolvedValue(null);

    const map = await guardianBulkActionGate({
      items: [bulkItem({ index: 0, targetItemId: 'tgt-a' }), bulkItem({ index: 1, targetItemId: 'tgt-b' })],
    });

    expect(getWardAge).toHaveBeenCalledTimes(1);
    expect(map.size).toBe(0);
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('gates only the minor when a batch mixes a minor, an adult and an age-unknown ward', async () => {
    getWardAge.mockImplementation((ward: string) =>
      Promise.resolve(ward === 'minor' ? 11 : ward === 'adult' ? 30 : null),
    );
    issueGuardianOtp.mockResolvedValue(undefined);

    const map = await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, wardUserId: 'minor' }),
        bulkItem({ index: 1, wardUserId: 'adult' }),
        bulkItem({ index: 2, wardUserId: 'unknown' }),
      ],
    });

    expect(map.get(0)).toEqual({ status: 'challenge_issued' });
    expect(map.has(1)).toBe(false);
    expect(map.has(2)).toBe(false);
    expect(issueGuardianOtp).toHaveBeenCalledTimes(1);
  });

  it('de-duplicates provider org names in submit order and drops nulls', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianNamePlaintext.mockResolvedValue(null);
    resolveProviderServiceName.mockImplementation((id: string) =>
      Promise.resolve(id === 'tgt-c' ? null : id === 'tgt-b' ? 'Acme' : 'Acme'),
    );
    issueGuardianOtp.mockResolvedValue(undefined);

    await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, targetItemId: 'tgt-a' }),
        bulkItem({ index: 1, targetItemId: 'tgt-b' }),
        bulkItem({ index: 2, targetItemId: 'tgt-c' }),
      ],
    });

    const call = issueGuardianOtp.mock.calls[0][0];
    expect(call.scenario.providerOrgNames).toEqual(['Acme']);
    // parentName is dropped from variables when the lookup returns null.
    expect(call.variables).toEqual({});
  });

  it('sets jobs:false for a non-blue_dot network (opportunities copy)', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockResolvedValue(undefined);

    await guardianBulkActionGate({ items: [bulkItem({ index: 0, network: 'yellow_dot' })] });

    expect(issueGuardianOtp.mock.calls[0][0].scenario).toMatchObject({
      kind: 'action_bulk',
      jobs: false,
      stage: 'initiate',
    });
  });
});

describe('guardianBulkActionGate — per-bucket failure isolation', () => {
  it('assigns no_provider to the whole bucket when the guardian has no contact', async () => {
    getWardAge.mockResolvedValue(11);
    getGuardianContactPlaintext.mockResolvedValue(null);

    const map = await guardianBulkActionGate({
      items: [bulkItem({ index: 0, targetItemId: 'tgt-a' }), bulkItem({ index: 1, targetItemId: 'tgt-b' })],
    });

    expect(map.get(0)).toEqual({ status: 'no_provider' });
    expect(map.get(1)).toEqual({ status: 'no_provider' });
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });

  it('rate-limits one ward’s bucket and still issues for the other ward', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockImplementation((args: { scope: string }) =>
      args.scope.includes('ward-1')
        ? Promise.reject(new GuardianOtpError('RATE_LIMITED'))
        : Promise.resolve(undefined),
    );

    const map = await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, wardUserId: 'ward-1' }),
        bulkItem({ index: 1, wardUserId: 'ward-2' }),
      ],
    });

    expect(map.get(0)).toEqual({ status: 'rate_limited' });
    expect(map.get(1)).toEqual({ status: 'challenge_issued' });
  });

  it('maps a NO_OTP_PROVIDER raised by the issuer to no_provider for that bucket only', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockImplementation((args: { scope: string }) =>
      args.scope.includes('ward-1')
        ? Promise.reject(new GuardianOtpError('NO_OTP_PROVIDER'))
        : Promise.resolve(undefined),
    );

    const map = await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, wardUserId: 'ward-1' }),
        bulkItem({ index: 1, wardUserId: 'ward-2' }),
      ],
    });

    expect(map.get(0)).toEqual({ status: 'no_provider' });
    expect(map.get(1)).toEqual({ status: 'challenge_issued' });
  });

  it('re-throws a non-GuardianOtpError from the bulk issuer', async () => {
    getWardAge.mockResolvedValue(11);
    issueGuardianOtp.mockRejectedValue(new Error('notifier exploded'));

    await expect(guardianBulkActionGate({ items: [bulkItem({ index: 0 })] })).rejects.toThrow(
      'notifier exploded',
    );
  });

  it('throttles one ward’s bucket on verify while the other ward still verifies', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockImplementation((scope: string) =>
      scope.includes('ward-1')
        ? Promise.reject(new GuardianOtpError('VERIFY_THROTTLED'))
        : Promise.resolve(undefined),
    );
    verifyGuardianOtp.mockResolvedValue(true);

    const map = await guardianBulkActionGate({
      items: [
        bulkItem({ index: 0, wardUserId: 'ward-1' }),
        bulkItem({ index: 1, wardUserId: 'ward-2' }),
      ],
      otp: '123456',
    });

    expect(map.get(0)).toEqual({ status: 'throttled' });
    expect(map.get(1)).toEqual({ status: 'verified' });
    // The throttled bucket never reaches (and never consumes) the OTP.
    expect(verifyGuardianOtp).toHaveBeenCalledTimes(1);
  });

  it('re-throws a non-throttle error from the bulk verify throttle', async () => {
    getWardAge.mockResolvedValue(11);
    assertVerifyAttemptAllowed.mockRejectedValue(new GuardianOtpError('RATE_LIMITED'));

    await expect(
      guardianBulkActionGate({ items: [bulkItem({ index: 0 })], otp: '123456' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(verifyGuardianOtp).not.toHaveBeenCalled();
  });

  it('returns an empty map for an empty submit without touching any dependency', async () => {
    const map = await guardianBulkActionGate({ items: [] });

    expect(map.size).toBe(0);
    expect(getNetworkConfigById).not.toHaveBeenCalled();
    expect(issueGuardianOtp).not.toHaveBeenCalled();
  });
});

describe('guardianGateFailure — remaining status mappings', () => {
  it('maps challenge_issued to GUARDIAN_OTP_REQUIRED', () => {
    const failure = guardianGateFailure({ status: 'challenge_issued' });
    expect(failure?.errorCode).toBe('GUARDIAN_OTP_REQUIRED');
    expect(failure?.message).toContain('guardian_otp');
  });

  it('maps invalid_otp / throttled / rate_limited / no_provider to their own codes', () => {
    expect(guardianGateFailure({ status: 'invalid_otp' })?.errorCode).toBe('GUARDIAN_OTP_INVALID');
    expect(guardianGateFailure({ status: 'throttled' })?.errorCode).toBe('GUARDIAN_OTP_THROTTLED');
    expect(guardianGateFailure({ status: 'rate_limited' })?.errorCode).toBe(
      'GUARDIAN_OTP_RATE_LIMITED',
    );
    expect(guardianGateFailure({ status: 'no_provider' })?.errorCode).toBe(
      'OTP_PROVIDER_UNAVAILABLE',
    );
  });
});

// The real primitives (not the mocked seam above) — the per-guardian-CONTACT
// send cap and the HTTP reply ladder.
describe('guardian_otp primitives (real module)', () => {
  const loadReal = () =>
    vi.importActual<typeof import('@/services/guardian_otp')>('@/services/guardian_otp');

  it('caps sends per guardian contact even when the ward scope rotates', async () => {
    const otp = await loadReal();
    const send = vi.fn(async (_args: { contact: string; contactType: 'phone' | 'email'; otp: string }) => {});

    for (let i = 0; i < otp.GUARDIAN_OTP_CONTACT_MAX_PER_WINDOW; i++) {
      // A fresh scope each time, so the per-scope cap never trips.
      await otp.issueGuardianOtp({ scope: `ward-${i}`, contact: '+911234', contactType: 'phone', send });
    }
    expect(send).toHaveBeenCalledTimes(otp.GUARDIAN_OTP_CONTACT_MAX_PER_WINDOW);

    await expect(
      otp.issueGuardianOtp({ scope: 'ward-fresh', contact: '+911234', contactType: 'phone', send }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    // Nothing extra was dispatched to the victim contact.
    expect(send).toHaveBeenCalledTimes(otp.GUARDIAN_OTP_CONTACT_MAX_PER_WINDOW);
  });

  it('counts the contact separately per contact type (hashed key includes the type)', async () => {
    const otp = await loadReal();
    const send = vi.fn(async () => {});

    for (let i = 0; i < otp.GUARDIAN_OTP_CONTACT_MAX_PER_WINDOW; i++) {
      await otp.issueGuardianOtp({ scope: `w-${i}`, contact: 'shared@x.co', contactType: 'email', send });
    }
    // Same string, different contactType → its own counter, so this still sends.
    await expect(
      otp.issueGuardianOtp({ scope: 'w-phone', contact: 'shared@x.co', contactType: 'phone', send }),
    ).resolves.toBeUndefined();
  });

  it('maps every GuardianOtpError code to its HTTP reply and returns null otherwise', async () => {
    const otp = await loadReal();

    expect(otp.guardianOtpErrorReply(new otp.GuardianOtpError('RATE_LIMITED'))).toEqual({
      status: 429,
      error: 'OTP_RATE_LIMITED',
      message: 'Too many OTP requests; try again shortly',
    });
    expect(otp.guardianOtpErrorReply(new otp.GuardianOtpError('NO_OTP_PROVIDER'))).toMatchObject({
      status: 503,
      error: 'OTP_PROVIDER_UNAVAILABLE',
    });
    expect(otp.guardianOtpErrorReply(new otp.GuardianOtpError('VERIFY_THROTTLED'))).toMatchObject({
      status: 429,
      error: 'OTP_VERIFY_THROTTLED',
    });
    expect(otp.guardianOtpErrorReply(new Error('boom'))).toBeNull();
    expect(otp.guardianOtpErrorReply('not-an-error')).toBeNull();
  });
});
