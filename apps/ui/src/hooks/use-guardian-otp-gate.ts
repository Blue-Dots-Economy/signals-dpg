import * as React from 'react';
import { guardianOtpErrorFromThrown, guardianSentToFromThrown } from '@/lib/action-api';

/**
 * The minor's guardian-OTP loop shared by the action components: a submit that
 * fails with `GUARDIAN_OTP_REQUIRED` stashes what to resubmit and opens the OTP
 * dialog; the entered code resubmits it and clears. `T` is whatever the caller
 * needs to replay the call.
 */
export function useGuardianOtpGate<T>(resubmit: (challenge: T, otp: string) => Promise<void>): {
  challenge: T | null;
  setChallenge: React.Dispatch<React.SetStateAction<T | null>>;
  /** Masked guardian contact the API reported for the current challenge. */
  sentTo: string | undefined;
  /** True (and stashes `challenge`) when `err` is GUARDIAN_OTP_REQUIRED; otherwise the caller handles `err`. */
  captureIfGuardianRequired: (err: unknown, challenge: T) => boolean;
  submitOtp: (otp: string) => Promise<void>;
} {
  const [challenge, setChallenge] = React.useState<T | null>(null);
  const [sentTo, setSentTo] = React.useState<string | undefined>(undefined);

  const captureIfGuardianRequired = React.useCallback((err: unknown, next: T): boolean => {
    if (guardianOtpErrorFromThrown(err) === 'GUARDIAN_OTP_REQUIRED') {
      setSentTo(guardianSentToFromThrown(err));
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

  return { challenge, setChallenge, sentTo, captureIfGuardianRequired, submitOtp };
}
