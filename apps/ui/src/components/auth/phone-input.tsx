import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';

/** Country code a phone field starts with. */
export const IN_DIAL_CODE = '+91';

/** National digits for India; E.164 caps a whole number at 15 digits. */
const IN_NATIONAL_DIGITS = 10;
const MAX_TOTAL_DIGITS = 15;

/** Name words that mark a phone field; "number"/"no" may follow them. */
const PHONE_WORDS = new Set(['phone', 'mobile']);
const NUMBER_WORDS = new Set(['number', 'no', 'num']);

/**
 * True when a field name ends in a phone word (`phone`, `contact_phone`,
 * `mobileNumber`, `Phone Number`); `phone_model` or `automobile` do not count.
 */
export function isPhoneFieldName(name: string): boolean {
  const words = name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const last = words.at(-1) ?? '';
  return PHONE_WORDS.has(last) || (NUMBER_WORDS.has(last) && PHONE_WORDS.has(words.at(-2) ?? ''));
}

/**
 * How a phone field stores its value, read from its schema `pattern`: with the
 * country code (`+91…`), or as the bare number when the pattern only accepts that.
 */
export function phoneValueMode(pattern: unknown): 'international' | 'national' {
  if (typeof pattern !== 'string') return 'international';
  try {
    const re = new RegExp(pattern);
    if (re.test('+919876543210')) return 'international';
    return re.test('9876543210') ? 'national' : 'international';
  } catch {
    return 'international';
  }
}

/** Keeps `+` and up to three digits, so the code box always reads `+NNN`. */
export function sanitizeDialCode(raw: string): string {
  return `+${raw.replace(/\D/g, '').slice(0, 3)}`;
}

/** Most national digits the number box accepts after `code`. */
export function nationalMaxLength(code: string): number {
  return code === IN_DIAL_CODE ? IN_NATIONAL_DIGITS : MAX_TOTAL_DIGITS - code.replace(/\D/g, '').length;
}

/**
 * Splits a stored value into code and number. A bare 10-digit value is read as
 * an Indian number, and `+91…` always as India.
 */
export function splitPhone(value: string | null | undefined): { code: string; national: string } {
  const raw = (value ?? '').replace(/[\s\-()]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    // `919876543210` is the +91 number without its plus.
    if (digits.length === 2 + IN_NATIONAL_DIGITS && digits.startsWith('91')) {
      return { code: IN_DIAL_CODE, national: digits.slice(2) };
    }
    return { code: IN_DIAL_CODE, national: digits };
  }
  if (digits.startsWith('91')) return { code: IN_DIAL_CODE, national: digits.slice(2) };
  // Without a country list, keep the last 10 digits as the number.
  const codeLength = Math.min(3, Math.max(1, digits.length - IN_NATIONAL_DIGITS));
  return { code: `+${digits.slice(0, codeLength)}`, national: digits.slice(codeLength) };
}

/**
 * Reads what was typed or pasted into the number box. A full number (`+91 98765
 * 43210`, `919876543210`) or one with a trunk `0` (`098765 43210`) is reduced to
 * its national part instead of being cut short into a different number.
 */
export function nationalFromInput(raw: string, code: string): { code: string; national: string } {
  const trimmed = raw.trim();
  if (trimmed.startsWith('+')) return splitPhone(trimmed);
  let digits = trimmed.replace(/\D/g, '');
  const codeDigits = code.replace(/\D/g, '');
  const max = nationalMaxLength(code);
  if (digits.length > max && codeDigits && digits.startsWith(codeDigits)) digits = digits.slice(codeDigits.length);
  if (digits.length === max + 1 && digits.startsWith('0')) digits = digits.slice(1);
  return { code, national: digits.slice(0, max) };
}

/** Joins code and number into the E.164 value; '' when no number was typed. */
export function joinPhone(code: string, national: string): string {
  const digits = national.replace(/\D/g, '');
  return digits ? `${sanitizeDialCode(code)}${digits}` : '';
}

/** True for any number the server would take as a contact (10-15 digits, landlines too). */
export function isAcceptedPhone(value: string): boolean {
  const raw = value.replace(/[\s\-()]/g, '');
  return /^\+?\d{10,15}$/.test(raw);
}

export interface PhoneInputProps {
  id: string;
  /** The full value, `+<code><number>` ('' when empty), or the bare number when `nationalOnly`. */
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
  /** Store only the 10-digit number (fields whose pattern takes no code); +91 is shown read-only. */
  nationalOnly?: boolean;
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
  nationalOnly = false,
}: Readonly<PhoneInputProps>) {
  const { t } = useTranslation();
  // The typed code is kept here, so it survives an empty number box and is not
  // re-guessed from the stored value while the user types.
  const [code, setCode] = React.useState(() => (value ? splitPhone(value).code : IN_DIAL_CODE));
  // A code box emptied to "+" keeps the number on its last full code.
  const editingCode = code.length > 1 ? code : null;
  const parts =
    !nationalOnly && editingCode && value.startsWith(editingCode)
      ? { code: editingCode, national: value.slice(editingCode.length).replace(/\D/g, '') }
      : splitPhone(value);
  const savedCode = nationalOnly ? IN_DIAL_CODE : value ? parts.code : (editingCode ?? IN_DIAL_CODE);
  const shownCode = code.length > 1 || nationalOnly ? savedCode : code;
  const max = nationalMaxLength(savedCode);

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
          readOnly={nationalOnly}
          onChange={(e) => {
            const nextCode = sanitizeDialCode(e.target.value);
            setCode(nextCode);
            // A bare "+" is not a code; keep the stored number until digits follow.
            if (nextCode.length < 2) return;
            const digits = parts.national.slice(0, nationalMaxLength(nextCode));
            if (digits) onChange(joinPhone(nextCode, digits));
          }}
          onBlur={(e) => {
            if (code.length < 2) setCode(savedCode);
            leave(e);
          }}
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
        onChange={(e) => {
          const next = nationalFromInput(e.target.value, savedCode);
          const nextCode = nationalOnly ? IN_DIAL_CODE : next.code;
          setCode(nextCode);
          onChange(nationalOnly ? next.national : joinPhone(nextCode, next.national));
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          if (!pasted) return;
          e.preventDefault();
          const next = nationalFromInput(pasted, savedCode);
          const nextCode = nationalOnly ? IN_DIAL_CODE : next.code;
          setCode(nextCode);
          onChange(nationalOnly ? next.national : joinPhone(nextCode, next.national));
        }}
        disabled={disabled}
        onBlur={leave}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? describedBy : undefined}
        className="min-w-0 flex-1 bg-transparent px-3 text-sm outline-none disabled:opacity-60"
      />
    </div>
  );
}
