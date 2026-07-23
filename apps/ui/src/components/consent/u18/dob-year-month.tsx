import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { boundaryBirthYear, buildYearMonthDob } from '@/lib/guardian-consent';

export interface DobYearMonthProps {
  /** Emits the built birth date (last day of month, Dec if no month), or
   *  undefined until the selection is complete. */
  onChange: (date: Date | undefined) => void;
  disabled?: boolean;
  idPrefix?: string;
}

const NOW = new Date();
const CURRENT_YEAR = NOW.getFullYear();
// Current year back 120y (covers minors too — a guardian may onboard a young
// ward). The server re-validates the allowed range.
const YEARS = Array.from({ length: 121 }, (_, i) => CURRENT_YEAR - i);
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * Minimal birth-date capture for U18 gating (#331): pick a YEAR; only when the
 * year is the "turns 18 this year" boundary do we also ask the MONTH (year
 * alone can't decide U18 there). The day is never collected — the emitted date
 * is the last day of the month (December when no month), which is fail-closed.
 * The parent keeps its existing `Date` contract.
 */
export function DobYearMonth({ onChange, disabled, idPrefix = 'dob' }: DobYearMonthProps) {
  const { t } = useTranslation();
  const [year, setYear] = React.useState<number | undefined>(undefined);
  const [month, setMonth] = React.useState<number | undefined>(undefined);

  const needsMonth = year !== undefined && year === boundaryBirthYear(NOW);

  // Emit whenever the selection becomes (in)complete. Boundary year needs the
  // month; every other year is decided by the year alone.
  const emit = (y: number | undefined, m: number | undefined) => {
    if (y === undefined) return onChange(undefined);
    if (y === boundaryBirthYear(NOW) && m === undefined) return onChange(undefined);
    onChange(buildYearMonthDob(y, y === boundaryBirthYear(NOW) ? m : undefined));
  };

  const selectClass =
    'h-11 w-full rounded-md border border-border bg-background px-3 text-sm disabled:opacity-60';

  return (
    <div className="flex flex-col gap-3">
      <div className="space-y-1.5">
        <label htmlFor={`${idPrefix}-year`} className="text-sm font-medium">
          {t('auth.dob_label_year', 'Birth year')}
        </label>
        <select
          id={`${idPrefix}-year`}
          className={selectClass}
          disabled={disabled}
          value={year ?? ''}
          onChange={(e) => {
            const y = e.target.value ? Number(e.target.value) : undefined;
            setYear(y);
            // Month only applies to the boundary year — clear it otherwise.
            const nextMonth = y === boundaryBirthYear(NOW) ? month : undefined;
            setMonth(nextMonth);
            emit(y, nextMonth);
          }}
        >
          <option value="">{t('auth.dob_year_placeholder', 'Year')}</option>
          {YEARS.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {needsMonth && (
        <div className="space-y-1.5">
          <label htmlFor={`${idPrefix}-month`} className="text-sm font-medium">
            {t('auth.dob_label_month', 'Birth month')}
          </label>
          <select
            id={`${idPrefix}-month`}
            className={selectClass}
            disabled={disabled}
            value={month ?? ''}
            onChange={(e) => {
              const m = e.target.value ? Number(e.target.value) : undefined;
              setMonth(m);
              emit(year, m);
            }}
          >
            <option value="">{t('auth.dob_month_placeholder', 'Month')}</option>
            {MONTHS.map((name, idx) => (
              <option key={name} value={idx + 1}>{t(`common.month_${idx + 1}`, name)}</option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
