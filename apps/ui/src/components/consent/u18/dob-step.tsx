import * as React from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { submitU18Dob } from '@/lib/consent-api';
import { DobCalendar } from '@/components/consent/u18/dob-calendar';

export interface DobStepProps {
  network: string;
  /** Called once the DOB has been recorded, with whether the ward is a minor. */
  onResolved: (isMinor: boolean) => void;
}

export function DobStep({ network, onResolved }: DobStepProps) {
  const { t } = useTranslation();
  const [birthDate, setBirthDate] = React.useState<Date | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const canSubmit = Boolean(birthDate) && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!birthDate) return;
    setIsSubmitting(true);
    try {
      const result = await submitU18Dob({
        network,
        dateOfBirth: birthDate.toISOString(),
      });
      onResolved(result.isMinor);
    } catch (err) {
      const status = axios.isAxiosError(err) ? err.response?.status : undefined;
      if (status === 400) {
        toast.error(t('u18.dob_error_invalid', 'That date of birth looks invalid.'));
      } else {
        toast.error(
          t('u18.dob_error_generic', "Couldn't save your date of birth. Please try again."),
        );
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="space-y-1.5">
        <Label htmlFor="u18-dob">{t('u18.dob_label', 'Select date of birth')}</Label>
        <DobCalendar
          id="u18-dob"
          value={birthDate}
          disabled={isSubmitting}
          placeholder={t('u18.dob_placeholder', 'Select date of birth')}
          onChange={setBirthDate}
        />
      </div>
      <Button type="submit" disabled={!canSubmit} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.dob_continue', 'Continue')}
      </Button>
    </form>
  );
}
