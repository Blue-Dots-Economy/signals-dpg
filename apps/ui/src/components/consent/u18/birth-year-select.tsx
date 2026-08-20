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
 *
 * Uses the app's own Select rather than a native `<select>`: the list is 121
 * options long, and a native select popup is sized by the browser — it opened
 * as a full-height column running off the top and bottom of the window, with
 * no usable scrollbar. This one is bounded and scrolls inside its own popup.
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
      {/* `position="popper"` is load-bearing, not decoration: SelectContent
          defaults to Radix's "item-aligned" mode, which centres the selected
          item over the trigger and so grows to fill the window — with 121
          years that renders as a full-height column of dates. Popper anchors
          the panel under the trigger instead, so `max-h-56` actually bounds it
          (~8 rows) and the list scrolls inside its own box. */}
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
