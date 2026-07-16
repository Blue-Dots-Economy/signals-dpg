import * as React from 'react';
import { guardianOtpErrorFromThrown } from '@/lib/action-api';

/**
 * The minor-ward guardian-OTP challenge/response loop shared by the action
 * components: an action submit that comes back `GUARDIAN_OTP_REQUIRED` stashes
 * the exact thing to resubmit, opens the OTP dialog, and — once the code is
 * entered — resubmits it with the OTP and clears. `T` is whatever the caller
 * needs to replay the call (action context, or an update payload).
 */
export function useGuardianOtpGate<T>(resubmit: (challenge: T, otp: string) => Promise<void>): {
  challenge: T | null;
  setChallenge: React.Dispatch<React.SetStateAction<T | null>>;
  /** Returns true (and stashes) when `err` is GUARDIAN_OTP_REQUIRED; else false — caller rethrows/handles. */
  captureIfGuardianRequired: (err: unknown, challenge: T) => boolean;
  submitOtp: (otp: string) => Promise<void>;
} {
  const [challenge, setChallenge] = React.useState<T | null>(null);

  const captureIfGuardianRequired = React.useCallback((err: unknown, next: T): boolean => {
    if (guardianOtpErrorFromThrown(err) === 'GUARDIAN_OTP_REQUIRED') {
      setChallenge(next);
      return true;
    }
    return false;
  }, []);

  const submitOtp = React.useCallback(
    async (otp: string) => {
      const current = challenge;
      if (current === null) return;
      await resubmit(current, otp);
      setChallenge(null);
    },
    [challenge, resubmit],
  );

  return { challenge, setChallenge, captureIfGuardianRequired, submitOtp };
}
