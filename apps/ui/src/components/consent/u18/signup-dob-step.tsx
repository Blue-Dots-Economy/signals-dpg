import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Info } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DobCalendar } from '@/components/consent/u18/dob-calendar';

export interface SignupDobStepProps {
  /**
   * Called with the chosen date once the ward taps Continue. Pure UI — no API
   * call (the account doesn't exist yet). The caller derives minor status and
   * routes to the guardian flow (minor) or account creation (adult).
   */
  onSubmit: (date: Date) => void;
}

/**
 * DOB capture step shown DURING signup, AFTER the name/domain form, and ONLY
 * when the chosen domain is guardian-gated (u18-enabled). Purely collects the
 * date; the caller decides minor -> guardian flow vs adult -> account creation.
 * Blocking dialog — cannot be dismissed mid-flow.
 */
export function SignupDobStep({ onSubmit }: SignupDobStepProps) {
  const { t } = useTranslation();
  const [birthDate, setBirthDate] = React.useState<Date | undefined>(undefined);

  return (
    <Dialog
      open
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
          <DialogTitle className="text-2xl">
            {t('auth.signup_dob_title', 'To create an account, please provide')}
          </DialogTitle>
        </DialogHeader>

        <form
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            if (birthDate) onSubmit(birthDate);
          }}
        >
          <div className="space-y-2">
            <label htmlFor="signup-dob-step" className="text-base font-semibold">
              {t('auth.signup_dob_label', 'Select date of birth')}
            </label>
            <DobCalendar
              id="signup-dob-step"
              value={birthDate}
              placeholder={t('auth.dob_placeholder', 'Select date of birth')}
              onChange={setBirthDate}
            />
          </div>

          <button
            type="submit"
            disabled={!birthDate}
            className="flex w-full items-center justify-center gap-2 rounded-md py-3 text-sm font-semibold transition-all disabled:opacity-60 bg-brand-cta h-12"
          >
            {t('auth.signup_dob_continue', 'Continue')}
            <ArrowRight className="h-4 w-4" />
          </button>

          <div className="rounded-lg border border-border bg-muted/50 p-4">
            <div className="mb-1 flex items-center gap-2">
              <Info className="h-4 w-4 text-muted-foreground" />
              <p className="text-sm font-semibold">{t('auth.signup_dob_how_title', 'How it works')}</p>
            </div>
            <p className="text-sm text-muted-foreground">
              {t(
                'auth.signup_dob_how_desc',
                "Enter your date of birth. If you are over 18, we'll take you to the account creation page. If you are a minor, under 18, we'll first collect consent from your guardian.",
              )}
            </p>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
