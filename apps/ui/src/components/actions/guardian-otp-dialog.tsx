import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, OctagonX } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-mobile';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { OtpInput } from '@/components/auth/otp-input';
import { guardianOtpErrorFromThrown, type GuardianOtpErrorCode } from '@/lib/action-api';

// Desktop: Dialog
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

// Mobile: Drawer
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from '@/components/ui/drawer';

export interface GuardianOtpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Called with the 6-digit code the ward entered. Should resubmit the SAME
   * action (perform/update-status) with `guardianOtp` set, and resolve on
   * success. The caller owns closing the dialog + toasting/refreshing on
   * success (typically by calling `onOpenChange(false)` at the end of this
   * function) — `GuardianOtpDialog` only renders the challenge UI and maps a
   * rejection into an inline error, it never closes itself.
   *
   * On failure, throw the original error (a `BulkSingleError` with `.code`,
   * or an axios error) — this component classifies it via
   * `guardianOtpErrorFromThrown` to pick the right inline message and resets
   * the OTP input so the ward can retry.
   */
  onSubmitOtp: (otp: string) => Promise<void>;
  /** Optional escape hatch — a stuck ward can sign out (wrong account / can't
   * reach the guardian). When provided, a "Not you? Log out" link is shown. */
  onLogout?: () => void;
}

interface InlineErrorState {
  code: GuardianOtpErrorCode | null;
  title: string;
  description: string;
}

function messageForCode(
  code: GuardianOtpErrorCode | null,
  t: (key: string, defaultValue: string) => string,
): { title: string; description: string } {
  switch (code) {
    case 'GUARDIAN_OTP_INVALID':
      return {
        title: t('actions.guardian_otp_error_invalid_title', 'Incorrect code'),
        description: t(
          'actions.guardian_otp_error_invalid_desc',
          'That code is invalid or expired. Please try again.',
        ),
      };
    case 'GUARDIAN_OTP_THROTTLED':
    case 'GUARDIAN_OTP_RATE_LIMITED':
      return {
        title: t('actions.guardian_otp_error_throttled_title', 'Too many attempts'),
        description: t(
          'actions.guardian_otp_error_throttled_desc',
          'Please wait a bit before trying again.',
        ),
      };
    case 'OTP_PROVIDER_UNAVAILABLE':
      return {
        title: t('actions.guardian_otp_error_unavailable_title', "Confirmation isn't available"),
        description: t(
          'actions.guardian_otp_error_unavailable_desc',
          "Guardian confirmation isn't available on this instance.",
        ),
      };
    default:
      return {
        title: t('actions.guardian_otp_error_generic_title', "Couldn't confirm the code"),
        description: t(
          'actions.guardian_otp_error_generic_desc',
          'Something went wrong confirming with your guardian. Please try again.',
        ),
      };
  }
}

export function GuardianOtpDialog({ open, onOpenChange, onSubmitOtp, onLogout }: GuardianOtpDialogProps) {
  const { t } = useTranslation();
  const isMobile = useIsMobile();
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [otpKey, setOtpKey] = React.useState(0);
  const [inlineError, setInlineError] = React.useState<InlineErrorState | null>(null);

  React.useEffect(() => {
    if (!open) return;
    setInlineError(null);
    setIsSubmitting(false);
    setOtpKey((k) => k + 1);
  }, [open]);

  const handleOtpComplete = async (otp: string) => {
    setIsSubmitting(true);
    setInlineError(null);
    try {
      await onSubmitOtp(otp);
    } catch (err) {
      const code = guardianOtpErrorFromThrown(err);
      const { title, description } = messageForCode(code, t);
      setInlineError({ code, title, description });
      // Reset the input so the ward can retry cleanly.
      setOtpKey((k) => k + 1);
    } finally {
      setIsSubmitting(false);
    }
  };

  const title = t(
    'actions.guardian_otp_title',
    "This requires your guardian's confirmation via OTP",
  );
  const description = t(
    'actions.guardian_otp_desc',
    'We sent a code to your guardian. Ask them for it and enter it below.',
  );

  const body = (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{description}</p>

      <div className="flex justify-center">
        <OtpInput key={otpKey} onComplete={(otp) => void handleOtpComplete(otp)} disabled={isSubmitting} />
      </div>

      {isSubmitting && (
        <div className="flex justify-center">
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

      {onLogout && (
        <div className="text-center">
          <button
            type="button"
            onClick={onLogout}
            className="text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
          >
            {t('u18.logout', 'Not you? Log out')}
          </button>
        </div>
      )}
    </div>
  );

  if (isMobile) {
    return (
      <Drawer open={open} onOpenChange={onOpenChange}>
        <DrawerContent className="max-h-[90dvh] overflow-hidden p-0">
          <DrawerHeader className="text-left">
            <DrawerTitle>{title}</DrawerTitle>
          </DrawerHeader>
          <div className="px-6 pb-6">{body}</div>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[440px] gap-4 p-6">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        {body}
      </DialogContent>
    </Dialog>
  );
}
