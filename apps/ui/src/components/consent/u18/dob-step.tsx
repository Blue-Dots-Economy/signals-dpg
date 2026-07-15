import * as React from 'react';
import axios from 'axios';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { submitU18Dob } from '@/lib/consent-api';
import { MONTHS, buildYearOptions } from '@/lib/dob-options';

export interface DobStepProps {
  network: string;
  /** Called once the DOB has been recorded, with whether the ward is a minor. */
  onResolved: (isMinor: boolean) => void;
}

export function DobStep({ network, onResolved }: DobStepProps) {
  const { t } = useTranslation();
  const [birthMonth, setBirthMonth] = React.useState('');
  const [birthYear, setBirthYear] = React.useState('');
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const years = React.useMemo(() => buildYearOptions(), []);

  const canSubmit = Boolean(birthMonth) && Boolean(birthYear) && !isSubmitting;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!birthMonth || !birthYear) return;
    setIsSubmitting(true);
    try {
      const result = await submitU18Dob({
        network,
        birthYear: Number(birthYear),
        birthMonth: Number(birthMonth),
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
      <p className="text-sm text-muted-foreground">
        {t(
          'u18.dob_desc',
          'We ask for your birth month and year to check whether a parent/guardian needs to confirm your account.',
        )}
      </p>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="u18-dob-month">{t('u18.dob_label_month', 'Birth month')}</Label>
          <select
            id="u18-dob-month"
            value={birthMonth}
            onChange={(e) => setBirthMonth(e.target.value)}
            disabled={isSubmitting}
            required
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="" disabled>
              {t('u18.dob_month_placeholder', 'Month')}
            </option>
            {MONTHS.map((label, idx) => (
              <option key={label} value={idx + 1}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="u18-dob-year">{t('u18.dob_label_year', 'Birth year')}</Label>
          <select
            id="u18-dob-year"
            value={birthYear}
            onChange={(e) => setBirthYear(e.target.value)}
            disabled={isSubmitting}
            required
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <option value="" disabled>
              {t('u18.dob_year_placeholder', 'Year')}
            </option>
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </div>
      </div>
      <Button type="submit" disabled={!canSubmit} className="w-full">
        {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
        {t('u18.dob_continue', 'Continue')}
      </Button>
    </form>
  );
}
