import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/config')>();
  return {
    ...actual,
    authConfig: { ...actual.authConfig, create_test_otp: false },
  };
});

// --- mocks (hoisted) -------------------------------------------------------
const { redisIncr, redisExpire, resetStore } = vi.hoisted(() => {
  let store = new Map<string, string>();
  return {
    redisIncr: vi.fn(async (k: string) => {
      const n = Number(store.get(k) ?? '0') + 1;
      store.set(k, String(n));
      return n;
    }),
    redisExpire: vi.fn(async () => 1),
    resetStore: () => {
      store = new Map<string, string>();
    },
  };
});

vi.mock('@api/db/secondary/redis', () => ({
  redis: {
    incr: redisIncr,
    expire: redisExpire,
  },
}));

import {
  assertVerifyAttemptAllowed,
  GUARDIAN_OTP_VERIFY_MAX,
} from '@/services/guardian_otp';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe('assertVerifyAttemptAllowed', () => {
  it('allows up to the max, throws VERIFY_THROTTLED after', async () => {
    for (let i = 0; i < GUARDIAN_OTP_VERIFY_MAX; i++) {
      await assertVerifyAttemptAllowed('u1');
    }
    await expect(assertVerifyAttemptAllowed('u1')).rejects.toMatchObject({
      code: 'VERIFY_THROTTLED',
    });
  });
});
