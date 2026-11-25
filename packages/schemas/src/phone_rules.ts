/**
 * Per-country phone rules shared by the API and UI, backed by libphonenumber-js.
 * Callers pass the deployment's countries (`PHONE_COUNTRIES` /
 * `VITE_PHONE_COUNTRIES`); the first one is the country a number without a `+`
 * is read in. Same rules and messages as aggregator-dpg's `parsePhone`.
 */

import {
  getCountryCallingCode,
  getExampleNumber,
  isSupportedCountry,
  Metadata,
  parsePhoneNumberFromString,
  type CountryCode,
  type PhoneNumberType,
} from 'libphonenumber-js/max';
import mobileExamples from 'libphonenumber-js/mobile/examples';

export type { CountryCode };

/** A stored phone: `+` and 10-15 digits, as the aggregator stores it. */
export const PHONE_E164_SHAPE = /^\+[1-9]\d{9,14}$/;

/** What a typed phone may contain: a leading `+`, digits, spaces, dashes, dots, brackets. */
export const PHONE_INPUT_SHAPE = /^\+?[\d\s\-().]+$/;

/** Which numbers a field takes: `mobile` for a login or OTP phone, `any` for a contact phone. */
export type PhoneKind = 'mobile' | 'any';

/** Why a phone was refused. */
export type PhoneParseReason =
  'empty' | 'not_a_number' | 'country_not_allowed' | 'invalid' | 'not_mobile';

/** A deployment's accepted countries; the first is the default. */
export type PhoneCountryList = readonly [CountryCode, ...CountryCode[]];

/** The countries a field accepts and the kind of number it needs. */
export interface PhoneRules {
  countries: PhoneCountryList;
  kind: PhoneKind;
}

/** Outcome of {@link parsePhone}: the E.164 phone, or the reason it was refused. */
export type PhoneParseResult =
  { ok: true; value: string } | { ok: false; error: { reason: PhoneParseReason; message: string } };

/** Countries used when the country list is blank. */
export const DEFAULT_PHONE_COUNTRIES: PhoneCountryList = ['IN'];

/** Number types a mobile field accepts; US and CA do not tell mobiles from landlines. */
const MOBILE_TYPES: ReadonlySet<PhoneNumberType> = new Set<PhoneNumberType>([
  'MOBILE',
  'FIXED_LINE_OR_MOBILE',
]);

function refuse(reason: PhoneParseReason, message: string): PhoneParseResult {
  return { ok: false, error: { reason, message } };
}

/**
 * Parses a phone typed in any spacing or punctuation and checks it against its
 * own country's rules. A country is allowed by its calling code, so GB also
 * admits other +44 numbers (Guernsey, Jersey) and US admits Canada.
 */
export function parsePhone(raw: string, rules: PhoneRules): PhoneParseResult {
  if (!raw?.trim()) return refuse('empty', 'phone is empty');
  const phone = parsePhoneNumberFromString(raw, rules.countries[0]);
  if (!phone) return refuse('not_a_number', 'phone is not a phone number');

  const code = `+${phone.countryCallingCode}`;
  const allowed = rules.countries.some(
    (c) => getCountryCallingCode(c) === phone.countryCallingCode,
  );
  if (!allowed) {
    return refuse('country_not_allowed', `phone numbers starting ${code} are not accepted`);
  }
  if (!phone.isValid() || !PHONE_E164_SHAPE.test(phone.number)) {
    return refuse('invalid', `phone is not a valid ${code} number`);
  }

  const type = phone.getType();
  if (rules.kind === 'mobile' && !(type && MOBILE_TYPES.has(type))) {
    return refuse('not_mobile', 'phone must be a mobile number');
  }
  return { ok: true, value: phone.number };
}

/** Outcome of {@link readPhoneCountries}. */
export type PhoneCountriesResult =
  { ok: true; value: PhoneCountryList } | { ok: false; error: { message: string } };

/** One country-list entry: two-letter country, `:`, then the dial code with an optional `+`. */
const COUNTRY_ENTRY = /^([A-Za-z]{2})\s*:\s*\+?(\d+)$/;

/**
 * Reads a deployment's country list, e.g. `IN:+91,GB:+44`. The first entry is
 * the default. Every entry must be a known country with its real dial code, so
 * a typo fails instead of silently changing the default. Blank means India.
 */
export function readPhoneCountries(raw: string | undefined): PhoneCountriesResult {
  if (!raw?.trim()) return { ok: true, value: DEFAULT_PHONE_COUNTRIES };
  const list: CountryCode[] = [];
  for (const entry of raw.split(',').map((e) => e.trim())) {
    const bad = (why: string): PhoneCountriesResult => ({
      ok: false,
      error: { message: `PHONE_COUNTRIES entry "${entry}" ${why}` },
    });
    const match = COUNTRY_ENTRY.exec(entry);
    const iso = match?.[1]?.toUpperCase();
    const dial = match?.[2];
    if (!iso || !dial) return bad('is not in the form XX:+NN');
    if (!isSupportedCountry(iso)) return bad(`has an unknown country ${iso}`);
    const real = getCountryCallingCode(iso);
    if (dial !== real) return bad(`has the wrong dial code; ${iso} is +${real}`);
    if (list.includes(iso)) return bad('is listed twice');
    if (list.some((c) => getCountryCallingCode(c) === real)) {
      return bad(`repeats the dial code +${real}; list one country per code`);
    }
    if (real.length + phoneCountryInfo(iso).sample.length < MIN_STORED_DIGITS) {
      return bad(`is not supported; ${iso} mobile numbers are shorter than a stored phone allows`);
    }
    list.push(iso);
  }
  const [first, ...rest] = list;
  return first
    ? { ok: true, value: [first, ...rest] }
    : { ok: true, value: DEFAULT_PHONE_COUNTRIES };
}

/** What a phone box needs to know about one country. */
export interface PhoneCountryInfo {
  iso: CountryCode;
  /** Dial code with its plus, e.g. `+91`. */
  code: string;
  /** Most digits a mobile or landline number has after the dial code. */
  nationalDigits: number;
  /** A valid mobile number without the dial code. */
  sample: string;
}

/** Longest national number E.164 allows, used when the library has no lengths. */
const MAX_NATIONAL_DIGITS = 14;

/** Fewest and most digits in a stored phone, code included ({@link PHONE_E164_SHAPE}). */
const MIN_STORED_DIGITS = 10;
const MAX_E164_DIGITS = 15;

const METADATA = new Metadata();

/** Possible national lengths of one number type; `type()` is untyped, so it is checked at runtime. */
function typeLengths(plan: unknown, type: 'MOBILE' | 'FIXED_LINE'): number[] {
  const typeOf: unknown =
    typeof plan === 'object' && plan !== null ? Reflect.get(plan, 'type') : null;
  if (typeof typeOf !== 'function') return [];
  const desc: unknown = Reflect.apply(typeOf, plan, [type]);
  const lengthsOf: unknown =
    typeof desc === 'object' && desc !== null ? Reflect.get(desc, 'possibleLengths') : null;
  if (typeof lengthsOf !== 'function') return [];
  const lengths: unknown = Reflect.apply(lengthsOf, desc, []);
  return Array.isArray(lengths) ? lengths.filter((n): n is number => typeof n === 'number') : [];
}

/** Longest national number a mobile or landline in `iso` can have; 0 when unknown. */
function longestNationalNumber(iso: CountryCode): number {
  METADATA.selectNumberingPlan(iso);
  const plan = METADATA.numberingPlan;
  return Math.max(0, ...typeLengths(plan, 'MOBILE'), ...typeLengths(plan, 'FIXED_LINE'));
}

/** Describes a country for a phone box: its dial code, mobile length and a sample mobile. */
export function phoneCountryInfo(iso: CountryCode): PhoneCountryInfo {
  const example = getExampleNumber(iso, mobileExamples);
  const dial = getCountryCallingCode(iso);
  const sample = example ? String(example.nationalNumber) : '';
  return {
    iso,
    code: `+${dial}`,
    nationalDigits: Math.min(
      Math.max(sample.length, longestNationalNumber(iso)) || MAX_NATIONAL_DIGITS,
      MAX_E164_DIGITS - dial.length,
    ),
    sample,
  };
}


/** Contact numbers (landlines too); same as the blue_dot `hiringManagerPhoneNumber` pattern. */
export const CONTACT_PHONE_PATTERN = /^(\+91[1-9]\d{9}|0?[1-9]\d{9}|\+[1-8]\d{9,14}|\+9[02-9]\d{8,13})$/;

/** A contact number after dropping spaces, dashes and brackets; a leading `00` reads as `+`. */
export function isContactPhone(value: string): boolean {
  return CONTACT_PHONE_PATTERN.test(value.replace(/[\s\-()]/g, '').replace(/^00/, '+'));
}
