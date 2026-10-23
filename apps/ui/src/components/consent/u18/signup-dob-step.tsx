import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Info } from 'lucide-react';
import { BirthYearSelect } from '@/components/consent/u18/birth-year-select';

export interface SignupDobStepProps {
  /** Called with the derived age on Continue. No API call. */
  onSubmit: (age: number) => void;
  /** True when an existing user is backfilling a missing DOB; switches the heading copy. */
  existing?: boolean;
}

/**
 * Birth-year step used only by the legacy OTP login page (`OtpLoginPage`),
 * whose OTP endpoints the API does not serve; the Keycloak panel does not use
 * it. Collects the age only; the caller routes minors to the guardian flow.
 */
export function SignupDobStep({ onSubmit, existing = false }: SignupDobStepProps) {
  const { t } = useTranslation();
  const [age, setAge] = React.useState<number | undefined>(undefined);

  return (
    <div className="flex flex-col gap-6">
      <h2 className="text-2xl font-bold text-foreground">
        {existing
          ? t('auth.dob_title_existing', 'Please confirm your birth year')
          : t('auth.signup_dob_title', 'To create an account, please provide')}
      </h2>

      <form
        className="flex flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (age !== undefined) onSubmit(age);
        }}
      >
        <div className="space-y-2">
          <label className="text-base font-semibold">
            {t('auth.signup_dob_label_ym', 'Select your birth year')}
          </label>
          <BirthYearSelect idPrefix="signup-dob" onChange={setAge} />
        </div>

        <button
          type="submit"
          disabled={age === undefined}
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
              "Select your birth year. If you are over 18, we'll take you to the account creation page. If you are a minor, under 18, we'll first collect consent from your guardian.",
            )}
          </p>
        </div>
      </form>
    </div>
  );
}
