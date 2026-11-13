/**
 * Phone formats the API accepts. `+91` (India) needs exactly 10 digits starting
 * 6-9; other country codes keep the E.164 length. Dial codes never share a
 * prefix, so a `+91…` value is always India. Same rule as the blue_dot schemas.
 */

/** E.164 only: `+91` and a 10-digit mobile, or another `+code` number. */
export const PHONE_E164_PATTERN = /^\+(91[6-9]\d{9}|[1-8]\d{9,14}|9[02-9]\d{8,13})$/;

/** What a sign-in form may send: E.164 as above, or a bare 10-digit Indian mobile. */
export const PHONE_INPUT_PATTERN = /^(\+(91[6-9]\d{9}|[1-8]\d{9,14}|9[02-9]\d{8,13})|[6-9]\d{9})$/;

/** Contact numbers (landlines too); same as the blue_dot `hiringManagerPhoneNumber` pattern. */
export const CONTACT_PHONE_PATTERN = /^(\+91[1-9]\d{9}|0?[1-9]\d{9}|\+[1-8]\d{9,14}|\+9[02-9]\d{8,13})$/;

/** A contact number after dropping spaces, dashes and brackets; a leading `00` reads as `+`. */
export function isContactPhone(value: string): boolean {
  return CONTACT_PHONE_PATTERN.test(value.replace(/[\s\-()]/g, '').replace(/^00/, '+'));
}
