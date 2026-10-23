import * as React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ageFromBirthYear } from '@/lib/guardian-consent';

export interface BirthYearSelectProps {
  /** Emits `currentYear - birthYear`, or undefined until a year is picked. */
  onChange: (age: number | undefined) => void;
  disabled?: boolean;
  idPrefix?: string;
}

const NOW = new Date();
const CURRENT_YEAR = NOW.getFullYear();
// Current year back 120 years; the server re-validates the range.
const YEARS = Array.from({ length: 121 }, (_, i) => CURRENT_YEAR - i);

/**
 * Birth-year capture for U18 gating. Month and day are never collected, so a
 * boundary-year person (age 18) counts as a minor, which is fail-closed.
 *
 * The app Select rather than a native `<select>`, whose 121-option popup the
 * browser sizes to the full window height.
 */
export function BirthYearSelect({ onChange, disabled, idPrefix = 'birth-year' }: BirthYearSelectProps) {
  const { t } = useTranslation();
  const [year, setYear] = React.useState<string>('');

  return (
    <Select
      value={year}
      disabled={disabled}
      onValueChange={(value) => {
        setYear(value);
        onChange(value ? ageFromBirthYear(Number(value), NOW) : undefined);
      }}
    >
      <SelectTrigger
        id={`${idPrefix}-year`}
        aria-label={t('auth.dob_label_year', 'Birth year')}
        className="h-11 w-full"
      >
        <SelectValue placeholder={t('auth.dob_year_placeholder', 'Year')} />
      </SelectTrigger>
      {/* `position="popper"` so `max-h-56` bounds the list; Radix's default
          item-aligned mode grows to fill the window. */}
      <SelectContent position="popper" className="max-h-56">
        {YEARS.map((y) => (
          <SelectItem key={y} value={String(y)}>
            {y}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
