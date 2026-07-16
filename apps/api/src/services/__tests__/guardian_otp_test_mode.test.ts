import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock config with create_test_otp enabled
vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    authConfig: { ...actual.authConfig, create_test_otp: true },
  };
});

const store = new Map<string, string>();

vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    set: vi.fn(async (k: string, v: string) => {
      store.set(k, v);
      return 'OK';
    }),
    del: vi.fn(async (k: string) => {
      store.delete(k);
      return 1;
    }),
    incr: vi.fn(async (k: string) => {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return n;
    }),
    expire: vi.fn(async () => 1),
    eval: vi.fn(async (_script: string, _numKeys: number, key: string, arg: string) => {
      if (store.get(key) === arg) {
        store.delete(key);
        return 1;
      }
      return 0;
    }),
  },
}));

import {
  issueGuardianOtp,
  verifyGuardianOtp,
} from '@/services/guardian_otp';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('guardian OTP test mode (create_test_otp: true)', () => {
  it('issues with fixed code 000000 and does not call send', async () => {
    const send = vi.fn(async (_args: { contact: string; contactType: 'phone' | 'email'; otp: string }) => {});
    await issueGuardianOtp({ scope: 'u1', contact: '+911', contactType: 'phone', send });
    // In test mode, send should NOT be called
    expect(send).not.toHaveBeenCalled();
    // The fixed code should be stored in Redis
    expect(await verifyGuardianOtp({ scope: 'u1', otp: '000000' })).toBe(true);
  });

  it('allows verification of the fixed 000000 code', async () => {
    const send = vi.fn(async () => {});
    await issueGuardianOtp({ scope: 'u2', contact: 'a@b.co', contactType: 'email', send });
    // Verify the code works
    expect(await verifyGuardianOtp({ scope: 'u2', otp: '000000' })).toBe(true);
    // Consumed → second verify fails
    expect(await verifyGuardianOtp({ scope: 'u2', otp: '000000' })).toBe(false);
  });

  it('rejects a wrong code even in test mode', async () => {
    const send = vi.fn(async () => {});
    await issueGuardianOtp({ scope: 'u3', contact: 'a@b.co', contactType: 'email', send });
    expect(await verifyGuardianOtp({ scope: 'u3', otp: '999999' })).toBe(false);
  });
});
