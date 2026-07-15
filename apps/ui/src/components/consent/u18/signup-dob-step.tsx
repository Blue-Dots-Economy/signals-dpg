import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Info } from 'lucide-react';
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
 * when the chosen domain is guardian-gated (u18-enabled). Rendered inline as
 * the auth page's content (inside AuthShell) — it REPLACES the signup form
 * rather than stacking as a modal over it. Purely collects the date; the
 * caller decides minor -> guardian flow vs adult -> account creation.
 */
export function SignupDobStep({ onSubmit }: SignupDobStepProps) {
  const { t } = useTranslation();
  const [birthDate, setBirthDate] = React.useState<Date | undefined>(undefined);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold text-foreground">
        {t('auth.signup_dob_title', 'To create an account, please provide')}
      </h2>

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
    </div>
  );
}
