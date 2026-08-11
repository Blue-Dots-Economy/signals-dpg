import * as React from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { submitU18Dob } from '@/lib/consent-api';
import { BirthYearSelect } from '@/components/consent/u18/birth-year-select';

export interface DobStepProps {
  network: string;
  /** Called once the DOB has been recorded, with whether the ward is a minor. */
  onResolved: (isMinor: boolean) => void;
}

export function DobStep({ network, onResolved }: DobStepProps) {
  const { t } = useTranslation();
  const [age, setAge] = React.useState<number | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const canSubmit = age !== undefined && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (age === undefined) return;
    setIsSubmitting(true);
    try {
      const result = await submitU18Dob({ network, age });
      onResolved(result.isMinor);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 400) {
        toast.error(t('u18.dob_error_invalid', 'That birth year looks invalid.'));
      } else {
        toast.error(
          t('u18.dob_error_generic', "Couldn't save your birth year. Please try again."),
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label>{t('u18.dob_label_ym', 'Select your birth year')}</Label>
        <BirthYearSelect idPrefix="u18-dob" disabled={isSubmitting} onChange={setAge} />
      </div>
      <Button type="submit" disabled={!canSubmit} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.dob_continue', 'Continue')}
      </Button>
    </form>
  );
}
