import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { getRuntimeEnv } from '@/lib/runtime-env';
import {
  parsePhone,
  phoneCountryInfo,
  readPhoneCountries,
  DEFAULT_PHONE_COUNTRIES as DEFAULT_COUNTRY_CODES,
  type CountryCode,
  type PhoneCountryList,
} from '@dpg/schemas/phone_rules';

/** A country a phone field can use. */
export interface PhoneCountry {
  /** ISO 3166-1 alpha-2 code, e.g. `IN`. */
  iso: CountryCode;
  /** Dial code with its plus, e.g. `+91`. */
  code: string;
  flag: string;
  /** Digits in a mobile number after the dial code. */
  nationalDigits: number;
  /** A valid national number, used to test a field's pattern. */
  sample: string;
}

function flagOf(iso: string): string {
  return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

function toPhoneCountries(list: PhoneCountryList): [PhoneCountry, ...PhoneCountry[]] {
  const describe = (iso: CountryCode): PhoneCountry => ({
    ...phoneCountryInfo(iso),
    flag: flagOf(iso),
  });
  const [first, ...rest] = list;
  return [describe(first), ...rest.map((iso) => describe(iso))];
}

const INDIA: PhoneCountry = toPhoneCountries(DEFAULT_COUNTRY_CODES)[0];

/**
 * Reads the deployment's country list, `IN:+91,GB:+44` (first is the default),
 * with the same rules as the API. A bad value is logged and falls back to India.
 */
export function parsePhoneCountries(raw: string | undefined): [PhoneCountry, ...PhoneCountry[]] {
  const read = readPhoneCountries(raw);
  if (read.ok) return toPhoneCountries(read.value);
  console.error(`VITE_PHONE_COUNTRIES: ${read.error.message}; using India only`);
  return [INDIA];
}

/** Countries a phone field offers (runtime `VITE_PHONE_COUNTRIES`); the first is the default. */
export const PHONE_COUNTRIES = parsePhoneCountries(getRuntimeEnv('VITE_PHONE_COUNTRIES'));

/** Country code a phone field starts with. */
export const DEFAULT_DIAL_CODE = PHONE_COUNTRIES[0].code;

/** The listed country for `code`, if any. */
export function phoneCountry(code: string): PhoneCountry | undefined {
  return PHONE_COUNTRIES.find((c) => c.code === code);
}

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

function patternTest(pattern: unknown): ((v: string) => boolean) | null {
  if (typeof pattern !== 'string') return null;
  try {
    const re = new RegExp(pattern);
    return (v) => re.test(v);
  } catch {
    return null;
  }
}

/**
 * True when a schema `pattern` accepts a number from a listed country, with or
 * without its code. Only such fields get the phone box; a phone-named field with
 * no pattern stays a plain text box, so its number is never rewritten.
 */
export function acceptsListedPhone(pattern: unknown): boolean {
  const test = patternTest(pattern);
  return !!test && PHONE_COUNTRIES.some((c) => test(`${c.code}${c.sample}`) || test(c.sample));
}

/**
 * How a phone field stores its value, read from its schema `pattern`: with the
 * country code (`+91…`), or as the bare number when the pattern only accepts that.
 */
export function phoneValueMode(pattern: unknown): 'international' | 'national' {
  const test = patternTest(pattern);
  if (!test || PHONE_COUNTRIES.some((c) => test(`${c.code}${c.sample}`))) return 'international';
  return PHONE_COUNTRIES.some((c) => test(c.sample)) ? 'national' : 'international';
}

/** Most national digits the number box accepts after `code`. */
export function nationalMaxLength(code: string): number {
  return phoneCountry(code)?.nationalDigits ?? MAX_TOTAL_DIGITS - code.replace(/\D/g, '').length;
}

/**
 * Splits a stored value into code and number. A value without `+` is read in
 * the first listed country, as the API does.
 */
export function splitPhone(value: string | null | undefined): { code: string; national: string } {
  const raw = (value ?? '').replace(/[\s\-()]/g, '');
  const digits = raw.replace(/\D/g, '');
  if (!raw.startsWith('+')) {
    const [home] = PHONE_COUNTRIES;
    const homeDigits = home.code.slice(1);
    // `919876543210` is the default country's number without its plus.
    if (digits.length === homeDigits.length + home.nationalDigits && digits.startsWith(homeDigits)) {
      return { code: home.code, national: digits.slice(homeDigits.length) };
    }
    // `09876543210` carries the trunk 0.
    if (digits.length === 1 + home.nationalDigits && digits.startsWith('0')) {
      return { code: home.code, national: digits.slice(1) };
    }
    return { code: home.code, national: digits };
  }
  const listed = PHONE_COUNTRIES.find((c) => digits.startsWith(c.code.slice(1)));
  if (listed) return { code: listed.code, national: digits.slice(listed.code.length - 1) };
  // An unlisted code: keep the last 10 digits as the number.
  const codeLength = Math.min(3, Math.max(1, digits.length - IN_NATIONAL_DIGITS));
  return { code: `+${digits.slice(0, codeLength)}`, national: digits.slice(codeLength) };
}

/**
 * Reads what was typed or pasted into the number box. A full number (`+91 98765
 * 43210`, `919876543210`) or one with a trunk `0` (`098765 43210`) is reduced to
 * its national part instead of being cut short into a different number. A number
 * with an unlisted code keeps all its digits, so it fails validation.
 */
export function nationalFromInput(raw: string, code: string): { code: string; national: string } {
  const trimmed = raw.trim().replace(/^00(?=[1-9])/, '+'); // `0091…` dials +91
  if (trimmed.startsWith('+')) {
    const parsed = parsePhone(trimmed, { countries: isoCodes(), kind: 'any' });
    const parts = splitPhone(parsed.ok ? parsed.value : trimmed); // drops a trunk 0
    if (phoneCountry(parts.code)) {
      return { code: parts.code, national: parts.national.slice(0, nationalMaxLength(parts.code)) };
    }
    return { code, national: trimmed.replace(/\D/g, '') };
  }
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
  return digits ? `${code}${digits}` : '';
}

function isoCodes(): PhoneCountryList {
  const [first, ...rest] = PHONE_COUNTRIES;
  return [first.iso, ...rest.map((c) => c.iso)];
}

/** A mobile in one of {@link PHONE_COUNTRIES}, by the API's own rule. */
export function isMobilePhone(value: string): boolean {
  return parsePhone(value, { countries: isoCodes(), kind: 'mobile' }).ok;
}

/** The number as the API stores it (E.164), or null when it is not valid in a listed country. */
export function storedPhone(value: string): string | null {
  const parsed = parsePhone(value, { countries: isoCodes(), kind: 'any' });
  return parsed.ok ? parsed.value : null;
}

/** A contact number (landlines too) in one of {@link PHONE_COUNTRIES}, by the API's own rule. */
export function isAcceptedPhone(value: string): boolean {
  return parsePhone(value, { countries: isoCodes(), kind: 'any' }).ok;
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
  /** Store only the national number (fields whose pattern takes no code); the code stays at the default. */
  nationalOnly?: boolean;
}

/**
 * Phone field: the country code, fixed to {@link PHONE_COUNTRIES} (a list only
 * when it has more than one), beside a number box that takes only digits and
 * stops at that country's length.
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
  // The picked country, kept while the number box is empty.
  const [picked, setPicked] = React.useState(() => (value ? splitPhone(value).code : DEFAULT_DIAL_CODE));
  const parts = splitPhone(value);
  const typedCode = value ? parts.code : picked;
  const code = nationalOnly ? DEFAULT_DIAL_CODE : typedCode;
  const country = phoneCountry(code);
  const apply = (raw: string) => {
    const next = nationalFromInput(raw, code);
    const nextCode = nationalOnly ? DEFAULT_DIAL_CODE : next.code;
    setPicked(nextCode);
    onChange(nationalOnly ? next.national : joinPhone(nextCode, next.national));
  };

  const leave = (e: React.FocusEvent<HTMLElement>) => {
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
      {PHONE_COUNTRIES.length > 1 && !nationalOnly ? (
        <select
          id={`${id}-code`}
          aria-label={t('auth.label_country_code', 'Country code')}
          value={code}
          disabled={disabled}
          onChange={(e) => {
            const nextCode = e.target.value;
            setPicked(nextCode);
            const digits = parts.national.slice(0, nationalMaxLength(nextCode));
            if (digits) onChange(joinPhone(nextCode, digits));
          }}
          onBlur={leave}
          className="border-r border-input bg-muted px-2 text-sm text-muted-foreground outline-none disabled:opacity-60"
        >
          {PHONE_COUNTRIES.map((c) => (
            <option key={c.code} value={c.code}>
              {`${c.flag} ${c.code}`}
            </option>
          ))}
        </select>
      ) : (
        <span
          aria-label={t('auth.label_country_code', 'Country code')}
          className="flex items-center gap-1 border-r border-input bg-muted px-3 text-sm text-muted-foreground select-none"
        >
          {country && <span aria-hidden="true">{country.flag}</span>}
          {code}
        </span>
      )}
      <input
        id={id}
        type="tel"
        inputMode="numeric"
        autoComplete="tel-national"
        maxLength={nationalMaxLength(code)}
        placeholder={placeholder}
        value={parts.national}
        onChange={(e) => apply(e.target.value)}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData('text');
          if (!pasted) return;
          e.preventDefault();
          apply(pasted);
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
