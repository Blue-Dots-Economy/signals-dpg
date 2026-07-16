import { useEffect, useState } from 'react';

/**
 * A resend countdown: ticks from `initialSeconds` down to 0 (one interval,
 * cleaned up on unmount / retick), and `restart()` resets it. Shared by the
 * login OTP page and the guardian OTP step so the timer isn't reimplemented.
 */
export function useResendCountdown(initialSeconds = 60): {
  countdown: number;
  restart: () => void;
} {
  const [countdown, setCountdown] = useState(initialSeconds);

  useEffect(() => {
    if (countdown <= 0) return;
    const interval = setInterval(() => {
      setCountdown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [countdown]);

  return { countdown, restart: () => setCountdown(initialSeconds) };
}
