import { APIError } from 'better-auth/api';
import type { UserWithPhoneNumber } from './unified_otp';

/**
 * Minimal view of better-auth's `secondaryStorage` — only the `delete` this
 * module needs, so callers can pass `ctx.context.secondaryStorage` directly and
 * tests can pass a stub.
 */
export interface OtpStorage {
  // Return kept loose to match better-auth's `secondaryStorage.delete`
  // (`Awaitable<string | void | null>`); the result is discarded.
  delete: (key: string) => unknown;
}

export interface DeliverOtpDeps {
  /** Present when the OTP is being delivered over SMS. */
  phoneNumber?: string;
  /** Present when the OTP is being delivered over email. */
  email?: string;
  otp: string;
  user: UserWithPhoneNumber | null;
  /** Storage key the OTP was written under, so it can be dropped on failure. */
  storageKey: string;
  storage: OtpStorage | null | undefined;
  sendPhoneOtp: (data: { phoneNumber: string; otp: string }) => Promise<void>;
  sendEmailOtp: (data: {
    email: string;
    otp: string;
    user: UserWithPhoneNumber | null;
  }) => Promise<void>;
}

/**
 * Deliver the OTP over the requested channel(s) and fail loudly if delivery
 * does not succeed.
 *
 * The send callbacks are **awaited** (a fire-and-forget email is invisible when
 * it rejects) and any rejection is turned into a `502 OTP_DELIVERY_FAILED`
 * instead of the endpoint reporting `ok: true` for a code that never arrived.
 * On failure the stored OTP is dropped so a retry issues a fresh one rather
 * than leaving a valid code stranded in storage for its full TTL.
 */
export async function deliverOtp(deps: DeliverOtpDeps): Promise<void> {
  const {
    phoneNumber,
    email,
    otp,
    user,
    storageKey,
    storage,
    sendPhoneOtp,
    sendEmailOtp,
  } = deps;

  try {
    if (phoneNumber) {
      await sendPhoneOtp({ phoneNumber, otp });
    }
    if (email) {
      await sendEmailOtp({ email, otp, user });
    }
  } catch {
    await storage?.delete(storageKey);
    throw new APIError('BAD_GATEWAY', {
      message:
        'We could not send your one-time password. Please try again shortly.',
      code: 'OTP_DELIVERY_FAILED',
    });
  }
}
