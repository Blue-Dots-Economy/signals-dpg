/**
 * Phone formats the API accepts. `+91` (India) needs exactly 10 digits starting
 * 6-9; other country codes keep the E.164 length. Dial codes never share a
 * prefix, so a `+91…` value is always India. Same rule as the blue_dot schemas.
 */

/** E.164 only: `+91` and a 10-digit mobile, or another `+code` number. */
export const PHONE_E164_PATTERN = /^\+(91[6-9]\d{9}|[1-8]\d{9,14}|9[02-9]\d{8,13})$/;

/** What a sign-in form may send: E.164 as above, or a bare 10-digit Indian mobile. */
export const PHONE_INPUT_PATTERN = /^(\+(91[6-9]\d{9}|[1-8]\d{9,14}|9[02-9]\d{8,13})|[6-9]\d{9})$/;

/** Indian national digits after `+91`. */
const IN_NATIONAL_DIGITS = 10;

/**
 * A contact number (landlines too): 10-15 digits with an optional `+`; a `+91`
 * number needs exactly 10 digits after the code.
 */
export function isContactPhone(value: string): boolean {
  const raw = value.replace(/[\s\-()]/g, '');
  if (!/^\+?\d{10,15}$/.test(raw)) return false;
  return !raw.startsWith('+91') || raw.length === '+91'.length + IN_NATIONAL_DIGITS;
}
