import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { submitU18Dob } from '@/lib/consent-api';
import { BirthYearSelect } from '@/components/consent/u18/birth-year-select';
import { apiErrorMessage, readApiError } from '@/lib/api-error';

export interface DobStepProps {
  network: string;
  /** Called once the DOB has been recorded, with whether the ward is a minor. */
  onResolved: (isMinor: boolean) => void;
}

export function DobStep({ network, onResolved }: DobStepProps) {
  const { t } = useTranslation();
  const [age, setAge] = React.useState<number | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    if (age === undefined) {
      setError(t('form.error_required', '{{label}} is required.', { label: t('auth.dob_label_year', 'Birth year') }));
      document.getElementById('u18-dob-year')?.focus();
      return;
    }
    setIsSubmitting(true);
    try {
      const result = await submitU18Dob({ network, age });
      onResolved(result.isMinor);
    } catch (err) {
      if (readApiError(err).status === 400) {
        setError(t('u18.dob_error_invalid', 'That birth year looks invalid.'));
      } else {
        toast.error(
          apiErrorMessage(err, t, t('u18.dob_error_generic', "Couldn't save your birth year. Please try again.")),
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="u18-dob-year">{t('u18.dob_label_ym', 'Select your birth year')}</Label>
        <BirthYearSelect
          idPrefix="u18-dob"
          disabled={isSubmitting}
          error={error}
          onChange={(next) => {
            setAge(next);
            setError(null);
          }}
        />
      </div>
      <Button type="submit" disabled={isSubmitting} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.dob_continue', 'Continue')}
      </Button>
    </form>
  );
}
