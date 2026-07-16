import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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

  // Reset the acknowledgement whenever the modal opens for a new profile.
  React.useEffect(() => {
    if (open) setChecked(false);
  }, [open]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Blocking: never dismiss via the Dialog's own open-change.
        if (!next) return;
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-lg"
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {minor
              ? t('consent.profile_title_minor', 'Guardian confirmation needed')
              : t('consent.profile_title')}
          </DialogTitle>
        </DialogHeader>

        {profileLabel && (
          <p className="text-sm text-muted-foreground">
            {t('consent.profile_for', { name: profileLabel })}
          </p>
        )}

        {minor ? (
          <div className="flex flex-col gap-4 py-2">
            <p className="text-sm text-muted-foreground">
              {t(
                'consent.profile_minor_desc',
                "You're under 18, so a parent or guardian must confirm this profile. Continue to send them a one-time code.",
              )}
            </p>
            <Button
              type="button"
              onClick={onAccept}
              className="w-full bg-brand-cta text-[var(--brand-cta-foreground)] hover:brightness-110"
            >
              {t('consent.profile_minor_continue', 'Send code to guardian')}
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
              onClick={onAccept}
              className="w-full bg-brand-cta text-[var(--brand-cta-foreground)] hover:brightness-110"
            >
              {t('consent.accept_continue')}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
