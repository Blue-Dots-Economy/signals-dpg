import { randomInt } from 'node:crypto';
import { redis } from '@api/db/secondary/redis';
import { getNotificationClient } from '@/utils/notificationClient';
import { authConfig } from '@/config';

/** Codes the primitive raises; callers map these to HTTP responses. */
export class GuardianOtpError extends Error {
  constructor(public code: 'RATE_LIMITED' | 'NO_OTP_PROVIDER' | 'VERIFY_THROTTLED') {
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
export const GUARDIAN_OTP_VERIFY_MAX = 5; // verify attempts per window
export const GUARDIAN_OTP_VERIFY_WINDOW_SEC = 300;

const codeKey = (scope: string) => `guardian_otp:code:${scope}`;
const rateKey = (scope: string) => `guardian_otp:rl:${scope}`;
const verifyRateKey = (scope: string) => `guardian_otp:vrl:${scope}`;

function generateOtp(): string {
  // Dev/test bypass (CREATE_TEST_OTP): fixed code so the guardian flow is
  // exercisable without a notifier. Guarded against production in config.
  if (authConfig.create_test_otp) return '000000';
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
  send?: OtpSend;
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
  // In test-OTP mode skip the real dispatch — no notifier is required and the
  // fixed code is already known to the tester.
  if (authConfig.create_test_otp) return;
  const send = args.send ?? defaultGuardianOtpSend;
  await send({ contact: args.contact, contactType: args.contactType, otp });
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

/**
 * Throttle verify attempts per scope (brute-force guard — the core OTP is a
 * 6-digit space). Throws VERIFY_THROTTLED past the window max. Call before
 * verifyGuardianOtp on the HTTP boundary.
 */
export async function assertVerifyAttemptAllowed(scope: string): Promise<void> {
  const k = verifyRateKey(scope);
  const count = await redis.incr(k);
  if (count === 1) {
    await redis.expire(k, GUARDIAN_OTP_VERIFY_WINDOW_SEC);
  }
  if (count > GUARDIAN_OTP_VERIFY_MAX) {
    throw new GuardianOtpError('VERIFY_THROTTLED');
  }
}

// Notification channel per guardian contact type (spec D7). WhatsApp is not
// wired — do not add it here.
const CHANNEL_BY_CONTACT_TYPE: Record<GuardianContactType, 'sms' | 'email'> = {
  phone: 'sms',
  email: 'email',
};

// TODO(#9): finalize ONEST guardian-OTP templates. Placeholder ids until then.
const GUARDIAN_OTP_TEMPLATE_ID: Record<'sms' | 'email', string> = {
  sms: 'guardian_otp_sms',
  email: 'guardian_otp_email',
};

/**
 * Default dispatch: pick the channel from the guardian's contact type and send
 * via the shared notification client. Hard-fails when no provider is
 * configured — a guardian-required domain must not silently skip verification.
 */
export const defaultGuardianOtpSend: OtpSend = async ({ contact, contactType, otp }) => {
  const client = getNotificationClient();
  if (!client) {
    throw new GuardianOtpError('NO_OTP_PROVIDER');
  }
  const channel = CHANNEL_BY_CONTACT_TYPE[contactType];
  await client.notify({
    channel,
    template_id: GUARDIAN_OTP_TEMPLATE_ID[channel],
    to: contact,
    priority: 'realtime',
    variables: { otp },
  });
};
