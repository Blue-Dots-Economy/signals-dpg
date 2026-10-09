/**
 * Canonical E.164 form (`+91XXXXXXXXXX`) of an Indian mobile number, or null.
 *
 * This is the shape `user.phone_number` and the Keycloak `phoneNumber`
 * attribute already hold, so a number normalised here can be matched against
 * either directly.
 *
 * Accepts separators (spaces, dashes, dots, brackets) and the common prefixes
 * `+91`, `91` and a trunk `0`. Rejects anything that is not then a 10-digit
 * number starting 6–9 (the Indian mobile range).
 */
export function normalizeIndianMobile(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.startsWith('+') && !trimmed.startsWith('+91')) return null;

  let digits = trimmed.replace(/[\s\-.()+]/g, '');
  if (!/^\d+$/.test(digits)) return null;

  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);

  return /^[6-9]\d{9}$/.test(digits) ? `+91${digits}` : null;
}
