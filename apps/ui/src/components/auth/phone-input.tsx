import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Country code a phone field starts with. */
export const IN_DIAL_CODE = '+91';

/** National digits for India; E.164 caps a whole number at 15 digits. */
const IN_NATIONAL_DIGITS = 10;
const MAX_TOTAL_DIGITS = 15;

/** Keeps `+` and up to three digits, so the code box always reads `+NNN`. */
export function sanitizeDialCode(raw: string): string {
  return `+${raw.replace(/\D/g, '').slice(0, 3)}`;
}

/** Most national digits the number box accepts after `code`. */
export function nationalMaxLength(code: string): number {
  return code === IN_DIAL_CODE ? IN_NATIONAL_DIGITS : MAX_TOTAL_DIGITS - code.replace(/\D/g, '').length;
}

/**
 * Splits a stored value into code and number. A bare 10-digit value (stored
 * before codes were editable) is read as an Indian number.
 */
export function splitPhone(value: string | null | undefined): { code: string; national: string } {
  const raw = (value ?? '').replace(/[\s\-()]/g, '');
  if (!raw.startsWith('+')) return { code: IN_DIAL_CODE, national: raw.replace(/\D/g, '') };
  const digits = raw.slice(1).replace(/\D/g, '');
  if (digits.startsWith('91') && digits.length === 2 + IN_NATIONAL_DIGITS) {
    return { code: IN_DIAL_CODE, national: digits.slice(2) };
  }
  // Codes are 1-3 digits; without a country list, keep the last 10 as the number.
  const codeLength = Math.min(3, Math.max(1, digits.length - IN_NATIONAL_DIGITS));
  return { code: `+${digits.slice(0, codeLength)}`, national: digits.slice(codeLength) };
}

/** Joins code and number into the E.164 value; '' when no number was typed. */
export function joinPhone(code: string, national: string): string {
  const digits = national.replace(/\D/g, '');
  return digits ? `${sanitizeDialCode(code)}${digits}` : '';
}

export interface PhoneInputProps {
  id: string;
  /** The full value, `+<code><number>`; '' when empty. */
  value: string;
  /** Receives the full value, or '' when the number box is empty. */
  onChange: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  invalid?: boolean;
  /** Id of the element holding this field's error message. */
  describedBy?: string;
  onBlur?: () => void;
  className?: string;
}

/**
 * Phone field: an editable country code that starts at +91, beside a number
 * box that takes only digits and stops at the length that code allows.
 */
export function PhoneInput({
  id,
  value,
  onChange,
  disabled,
  placeholder,
  invalid,
  describedBy,
  onBlur,
  className,
}: Readonly<PhoneInputProps>) {
  const { t } = useTranslation();
  // The typed code is kept here, so it survives an empty number box and is not
  // re-guessed from the stored value while the user types.
  const [code, setCode] = React.useState(() => (value ? splitPhone(value).code : IN_DIAL_CODE));
  const parts = value.startsWith(code)
    ? { code, national: value.slice(code.length).replace(/\D/g, '') }
    : splitPhone(value);
  const shownCode = value ? parts.code : code;
  const max = nationalMaxLength(shownCode);

  const leave = (e: React.FocusEvent<HTMLInputElement>) => {
    const next = e.relatedTarget;
    if (next instanceof HTMLElement && (next.id === id || next.id === `${id}-code`)) return;
    onBlur?.();
  };

  return (
    <div
      className={cn(
        'flex h-11 items-stretch overflow-hidden rounded-md border border-input bg-transparent shadow-xs focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
        invalid && 'border-destructive focus-within:border-destructive focus-within:ring-destructive/40',
        className,
      )}
    >
      <label className="flex items-center gap-1 border-r border-input bg-muted pl-3 text-sm text-muted-foreground">
        {shownCode === IN_DIAL_CODE && <span aria-hidden="true">🇮🇳</span>}
        <input
          id={`${id}-code`}
          type="tel"
          inputMode="tel"
          autoComplete="tel-country-code"
          aria-label={t('auth.label_country_code', 'Country code')}
          value={shownCode}
          maxLength={4}
          disabled={disabled}
          onChange={(e) => {
            const nextCode = sanitizeDialCode(e.target.value);
            setCode(nextCode);
            const digits = parts.national.slice(0, nationalMaxLength(nextCode));
            if (digits) onChange(joinPhone(nextCode, digits));
          }}
          onBlur={leave}
          className="w-12 bg-transparent pr-2 text-sm outline-none disabled:opacity-60"
        />
      </label>
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        maxLength={max}
        placeholder={placeholder}
        value={parts.national}
        onChange={(e) => onChange(joinPhone(shownCode, e.target.value.replace(/\D/g, '').slice(0, max)))}
        disabled={disabled}
        onBlur={leave}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? describedBy : undefined}
        className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none disabled:opacity-60"
      />
    </div>
  );
}
