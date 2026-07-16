import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    authConfig: { ...actual.authConfig, create_test_otp: false },
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
    // Emulates the CONSUME_IF_MATCH Lua: delete + return 1 only on match.
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
  GuardianOtpError,
  GUARDIAN_OTP_MAX_PER_WINDOW,
} from '@/services/guardian_otp';

beforeEach(() => {
  store.clear();
  vi.clearAllMocks();
});

describe('guardian OTP core', () => {
  it('issues: stores a 6-digit code and sends it to the contact', async () => {
    const send = vi.fn(async (_args: { contact: string; contactType: 'phone' | 'email'; otp: string }) => {});
    await issueGuardianOtp({ scope: 'u1', contact: '+911', contactType: 'phone', send });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0];
    expect(arg.contact).toBe('+911');
    expect(arg.contactType).toBe('phone');
    expect(arg.otp).toMatch(/^\d{6}$/);
  });

  it('verifies the issued code and consumes it (single-use)', async () => {
    let sent = '';
    const send = vi.fn(async (a: { otp: string }) => {
      sent = a.otp;
    });
    await issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send });
    expect(await verifyGuardianOtp({ scope: 'u1', otp: sent })).toBe(true);
    // consumed → second verify fails
    expect(await verifyGuardianOtp({ scope: 'u1', otp: sent })).toBe(false);
  });

  it('rejects a wrong or missing code', async () => {
    const send = vi.fn(async () => {});
    await issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send });
    expect(await verifyGuardianOtp({ scope: 'u1', otp: '000000' })).toBe(false);
    expect(await verifyGuardianOtp({ scope: 'other', otp: '000000' })).toBe(false);
  });

  it('rate-limits: throws RATE_LIMITED after the window max, without sending', async () => {
    const send = vi.fn(async () => {});
    for (let i = 0; i < GUARDIAN_OTP_MAX_PER_WINDOW; i++) {
      await issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send });
    }
    const sendsBefore = send.mock.calls.length;
    await expect(
      issueGuardianOtp({ scope: 'u1', contact: 'a@b.co', contactType: 'email', send }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect(send.mock.calls.length).toBe(sendsBefore); // no extra send
  });
});
