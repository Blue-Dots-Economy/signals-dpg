import { randomInt } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';

/** Codes the primitive raises; callers map these to HTTP responses. */
export class GuardianOtpError extends Error {
  constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER') {
    super(code);
    this.name = 'GuardianOtpError';
  }
}

export type GuardianContactType = 'phone' | 'email';

/** Dispatch seam — injected so the core is testable without the notifier. */
export type OtpSend = (args: {
  contact: string;
  contactType: GuardianContactType;
  otp: string;
}) => Promise<void>;

export const GUARDIAN_OTP_TTL_SEC = 300; // nonce lifetime (5 min)
export const GUARDIAN_OTP_MAX_PER_WINDOW = 3; // sends allowed per window
export const GUARDIAN_OTP_WINDOW_SEC = 300; // rate-limit window (5 min)

const codeKey = (scope: string) => `guardian_otp:code:${scope}`;
const rateKey = (scope: string) => `guardian_otp:rl:${scope}`;

function generateOtp(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

/**
 * Issue a guardian OTP for `scope` (e.g. a user id + purpose): rate-limit,
 * store the nonce with a short TTL, dispatch via `send`. Throws
 * `GuardianOtpError('RATE_LIMITED')` before sending when the window max is hit.
 */
export async function issueGuardianOtp(args: {
  scope: string;
  contact: string;
  contactType: GuardianContactType;
  send: OtpSend;
}): Promise<void> {
  const rk = rateKey(args.scope);
  const count = await redis.incr(rk);
  if (count === 1) {
    await redis.expire(rk, GUARDIAN_OTP_WINDOW_SEC);
  }
  if (count > GUARDIAN_OTP_MAX_PER_WINDOW) {
    throw new GuardianOtpError('RATE_LIMITED');
  }

  const otp = generateOtp();
  await redis.set(codeKey(args.scope), otp, 'EX', GUARDIAN_OTP_TTL_SEC);
  await args.send({ contact: args.contact, contactType: args.contactType, otp });
}

/**
 * Verify + consume a guardian OTP. Single-use: a correct code is deleted so it
 * cannot be replayed. Returns false for wrong/expired/missing codes.
 */
export async function verifyGuardianOtp(args: {
  scope: string;
  otp: string;
}): Promise<boolean> {
  const expected = await redis.get(codeKey(args.scope));
  if (expected && expected === args.otp) {
    await redis.del(codeKey(args.scope));
    return true;
  }
  return false;
}
