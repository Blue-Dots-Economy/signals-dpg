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
  onCancel: () => void;
}

export function ProfileConsentModal({
  open,
  statement,
  onAccept,
  onCancel,
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
          <DialogTitle>{t('consent.profile_title')}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <ConsentCheckbox
            text={statement}
            checked={checked}
            onCheckedChange={setChecked}
            id="profile-consent-checkbox"
          />

          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" onClick={onCancel}>
              {t('consent.cancel')}
            </Button>
            <Button
              type="button"
              disabled={!checked}
              onClick={onAccept}
              className="bg-brand-cta text-[var(--brand-cta-foreground)] hover:brightness-110"
            >
              {t('consent.accept_continue')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
