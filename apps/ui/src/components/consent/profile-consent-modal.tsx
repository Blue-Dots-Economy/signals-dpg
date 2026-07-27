import * as React from 'react';
import {
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { ConsentCheckbox } from '@/components/actions/consent-checkbox';
import { Button } from '@/components/ui/button';
import { useTranslation } from 'react-i18next';

export interface ProfileConsentModalProps {
  open: boolean;
  statement: string;
  onAccept: () => void;
  /** Display name of the profile this consent is for (shown so the user knows why it re-appeared per profile). */
  profileLabel?: string;
  /**
   * Minor ward: this profile's consent is GUARDIAN-given, not self-accepted.
   * Show guardian-oriented copy and a "send code to guardian" action instead of
   * the "I agree" self-consent checkbox — accepting issues the guardian OTP.
   */
  minor?: boolean;
}

export function ProfileConsentModal({
  open,
  statement,
  onAccept,
  profileLabel,
  minor = false,
}: ProfileConsentModalProps) {
  const { t } = useTranslation();
  const [checked, setChecked] = React.useState(false);
  // Minor flow is two-phase: tick the consent, THEN an under-18 notice that
  // hands off to guardian verification. Ticking is what reveals that the ward
  // needs a guardian — the age check runs on the acknowledgement, not up front.
  const [minorNotice, setMinorNotice] = React.useState(false);

  // Reset the acknowledgement whenever the modal opens for a new profile.
  React.useEffect(() => {
    if (open) {
      setChecked(false);
      setMinorNotice(false);
    }
  }, [open]);

  return (
    <ResponsiveDialog
      open={open}
      onOpenChange={(next) => {
        // Blocking: never dismiss via the Dialog's own open-change.
        if (!next) return;
      }}
      showCloseButton={false}
      contentClassName="max-w-lg"
      onInteractOutside={(e) => e.preventDefault()}
      onEscapeKeyDown={(e) => e.preventDefault()}
    >
      <div className="flex flex-col gap-4 overflow-y-auto p-6">
        <DialogHeader>
          <DialogTitle>
            {minor && minorNotice
              ? t('consent.profile_title_minor', 'Guardian confirmation needed')
              : t('consent.profile_title')}
          </DialogTitle>
        </DialogHeader>

        {profileLabel && (
          <p className="text-sm text-muted-foreground">
            {t('consent.profile_for', { name: profileLabel })}
          </p>
        )}

        {minor && minorNotice ? (
          // Under-18 notice: shown AFTER the ward ticks the consent, before the
          // guardian OTP is dispatched (onAccept issues the code).
          <div className="flex flex-col gap-4 py-2">
            <p className="text-sm text-muted-foreground">
              {t(
                'consent.profile_minor_notice',
                "You're under 18, so a parent or guardian needs to verify this profile creation. We'll send them a one-time code to confirm.",
              )}
            </p>
            <Button
              type="button"
              onClick={onAccept}
              className="w-full bg-brand-cta text-[var(--brand-cta-foreground)] hover:brightness-110"
            >
              {t('consent.profile_minor_verify', 'Verify with guardian')}
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4 py-2">
            <ConsentCheckbox
              text={statement}
              checked={checked}
              onCheckedChange={setChecked}
              id="profile-consent-checkbox"
            />

            <Button
              type="button"
              disabled={!checked}
              // Minor: ticking reveals the under-18 notice step; adults
              // self-accept immediately.
              onClick={() => (minor ? setMinorNotice(true) : onAccept())}
              className="w-full bg-brand-cta text-[var(--brand-cta-foreground)] hover:brightness-110"
            >
              {t('consent.accept_continue')}
            </Button>
          </div>
        )}
      </div>
    </ResponsiveDialog>
  );
}
