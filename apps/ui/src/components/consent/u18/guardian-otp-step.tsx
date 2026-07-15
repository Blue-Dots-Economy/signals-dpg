import * as React from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2, OctagonX } from 'lucide-react';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { OtpInput } from '@/components/auth/otp-input';
import { verifyGuardian, type VerifyGuardianResponse } from '@/lib/consent-api';

export interface GuardianOtpStepProps {
  network: string;
  brand?: string | null;
  onVerified: () => void;
  /** Re-sends the OTP by re-submitting the guardian details already on file. */
  onResend: () => Promise<void>;
  /**
   * Verify handler. Defaults to the authenticated `verifyGuardian`
   * (POST /u18/guardian/verify). The pre-auth signup flow injects a handler
   * that verifies via POST /u18/signup/guardian/verify (no session yet).
   */
  verify?: (otp: string) => Promise<VerifyGuardianResponse>;
}

export function GuardianOtpStep({
  network,
  brand,
  onVerified,
  onResend,
  verify = (otp) => verifyGuardian({ network, brand: brand ?? null, otp }),
}: GuardianOtpStepProps) {
  const { t } = useTranslation();
  const [isVerifying, setIsVerifying] = React.useState(false);
  const [isResending, setIsResending] = React.useState(false);
  const [countdown, setCountdown] = React.useState(60);
  const [otpKey, setOtpKey] = React.useState(0);
  const [inlineError, setInlineError] = React.useState<{ title: string; description: string } | null>(
    null,
  );

  React.useEffect(() => {
    if (countdown <= 0) return;
    const interval = setInterval(() => {
      setCountdown((c) => (c <= 1 ? 0 : c - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [countdown]);

  const handleOtpComplete = async (otp: string) => {
    setIsVerifying(true);
    setInlineError(null);
    try {
      const result = await verify(otp);
      if (result.verified) onVerified();
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      const code = axios.isAxiosError(err)
        ? (err.response?.data as { error?: string } | undefined)?.error
        : undefined;

      if (status === 429) {
        setInlineError({
          title: t('u18.otp_error_throttled_title', 'Too many attempts'),
          description: t(
            'u18.otp_error_throttled_desc',
            'Please wait a bit before trying again.',
          ),
        });
      } else if (code === 'CONSENT_VERSION_UNCONFIGURED') {
        setInlineError({
          title: t('u18.otp_error_generic_title', "Couldn't confirm the code"),
          description: t(
            'u18.otp_error_config_desc',
            "This instance isn't fully configured for guardian confirmation yet. Please contact support.",
          ),
        });
      } else {
        setInlineError({
          title: t('u18.otp_error_invalid_title', 'Incorrect code'),
          description: t('u18.otp_error_invalid_desc', 'That code is invalid or expired. Please try again.'),
        });
      }
      // Reset the input so the ward can retry cleanly.
      setOtpKey((k) => k + 1);
    } finally {
      setIsVerifying(false);
    }
  };

  const handleResend = async () => {
    if (countdown > 0 || isResending) return;
    setIsResending(true);
    setInlineError(null);
    try {
      await onResend();
      setCountdown(60);
      toast.success(t('u18.otp_resent', 'A new code has been sent to your guardian.'));
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 429) {
        toast.error(
          t('u18.guardian_error_rate_limited', 'Too many attempts. Please try again shortly.'),
        );
      } else if (status === 503) {
        toast.error(
          t(
            'u18.guardian_error_otp_unavailable',
            "Guardian confirmation isn't available on this instance right now.",
          ),
        );
      } else {
        toast.error(t('u18.otp_resend_error', "Couldn't resend the code. Please try again."));
      }
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {t('u18.otp_desc', "We sent a code to your guardian. Ask them for it and enter it below.")}
      </p>

      <div className="flex justify-start">
        <OtpInput key={otpKey} onComplete={handleOtpComplete} disabled={isVerifying} />
      </div>

      {isVerifying && (
        <div className="flex justify-start">
          <Loader2 className="h-5 w-5 animate-spin text-primary" />
        </div>
      )}

      {inlineError && (
        <Alert variant="destructive">
          <OctagonX className="h-4 w-4" />
          <AlertTitle>{inlineError.title}</AlertTitle>
          <AlertDescription>{inlineError.description}</AlertDescription>
        </Alert>
      )}

      <div className="text-left text-sm">
        {countdown > 0 ? (
          <p className="text-muted-foreground">
            {t('u18.otp_resend_countdown', 'Resend code in {{count}}s', { count: countdown })}
          </p>
        ) : (
          <button
            type="button"
            onClick={() => void handleResend()}
            disabled={isResending}
            className="text-primary hover:underline disabled:opacity-50"
          >
            {t('u18.otp_resend', 'Resend code')}
          </button>
        )}
      </div>
    </div>
  );
}
