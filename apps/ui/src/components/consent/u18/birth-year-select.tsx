import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { ageFromBirthYear } from '@/lib/guardian-consent';

export interface BirthYearSelectProps {
  /** Emits the derived age (currentYear - birthYear), or undefined until a
   *  year is picked. The birth day/month are never collected (#331). */
  onChange: (age: number | undefined) => void;
  disabled?: boolean;
  idPrefix?: string;
}

const NOW = new Date();
const CURRENT_YEAR = NOW.getFullYear();
// Current year back 120y (covers minors too — a guardian may onboard a young
// ward). The server re-validates the allowed range.
const YEARS = Array.from({ length: 121 }, (_, i) => CURRENT_YEAR - i);

/**
 * Minimal birth-year capture for U18 gating (#331): pick a YEAR, we derive an
 * age snapshot (`currentYear - birthYear`) and hand it to the parent. No month
 * or day is collected — a boundary-year person (e.g. 2008 in 2026 → age 18) is
 * treated as u18, which is fail-closed.
 */
export function BirthYearSelect({ onChange, disabled, idPrefix = 'birth-year' }: BirthYearSelectProps) {
  const { t } = useTranslation();
  const [year, setYear] = React.useState<number | undefined>(undefined);

  const selectClass =
    'h-11 w-full rounded-md border border-border bg-background px-3 text-sm disabled:opacity-60';

  // No visible label: callers (dob-step / signup-dob-step) already render one
  // above this. Keep an aria-label so the control still has an accessible name.
  return (
    <select
      id={`${idPrefix}-year`}
      aria-label={t('auth.dob_label_year', 'Birth year')}
      className={selectClass}
      disabled={disabled}
      value={year ?? ''}
      onChange={(e) => {
        const y = e.target.value ? Number(e.target.value) : undefined;
        setYear(y);
        onChange(y === undefined ? undefined : ageFromBirthYear(y, NOW));
      }}
    >
      <option value="">{t('auth.dob_year_placeholder', 'Year')}</option>
      {YEARS.map((y) => (
        <option key={y} value={y}>{y}</option>
      ))}
    </select>
  );
}
