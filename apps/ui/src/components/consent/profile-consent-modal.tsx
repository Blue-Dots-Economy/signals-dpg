import * as React from 'react';
import {
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResponsiveDialog } from '@/components/ui/responsive-dialog';
import { ConsentCheckbox } from '@/components/actions/consent-checkbox';
import { Button } from '@/components/ui/button';
import { ShieldCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export interface ProfileConsentModalProps {
  open: boolean;
  statement: string;
  onAccept: () => void;
  /** The profile this consent is for, since the modal re-appears per profile. */
  profileLabel?: string;
  /**
   * Minor ward: consent is guardian-given. After the checkbox, an under-18
   * notice offers "Verify with guardian"; `onAccept` then issues the guardian
   * OTP.
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
  // Minor flow is two-phase: the consent checkbox, then the under-18 notice.
  const [minorNotice, setMinorNotice] = React.useState(false);

  // Reset whenever the modal opens.
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
      dismissible={false}
      title={
        minor && minorNotice
          ? t('consent.profile_title_minor', 'Guardian confirmation needed')
          : t('consent.profile_title')
      }
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
          // Under-18 notice; onAccept issues the guardian code.
          <div className="flex flex-col gap-5 py-1">
            <div className="flex items-start gap-3 rounded-xl border bg-muted/50 p-4">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border bg-background text-[var(--brand-cta)]">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <p className="text-sm leading-relaxed text-muted-foreground">
                {t(
                  'consent.profile_minor_notice',
                  "You're under 18, so a guardian needs to verify this profile creation. We'll send them a one-time code to confirm.",
                )}
              </p>
            </div>
            <Button
              type="button"
              onClick={onAccept}
              className="w-full gap-2 bg-brand-cta text-[var(--brand-cta-foreground)] hover:brightness-110"
            >
              <ShieldCheck className="h-4 w-4" />
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
              // Minor: continue shows the under-18 notice; adults accept here.
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
