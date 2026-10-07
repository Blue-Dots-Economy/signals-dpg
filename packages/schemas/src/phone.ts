/**
 * Phone numbers in their canonical E.164 form (R14).
 *
 * The notification service accepts only E.164 (`+<country><number>`), so every
 * phone Signals stores, hashes or sends goes through this one function.
 */

/** The E.164 shape the notification service enforces on `to.phone`. */
export const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Normalises a typed phone number to E.164, or returns `null` when it cannot be
 * one.
 *
 * - Spaces, `(`, `)` and `-` are stripped.
 * - A bare 10-digit number is taken as Indian and gains `+91`.
 * - `91` followed by 10 digits gains the missing `+`.
 * - Anything else must already be `+<7–15 digits>`.
 */
export function normalizeE164Phone(raw: string): string | null {
  const compact = raw.trim().replace(/[\s()-]/g, '');
  let candidate = compact;
  if (/^\d{10}$/.test(compact)) candidate = `+91${compact}`;
  else if (/^91\d{10}$/.test(compact)) candidate = `+${compact}`;
  return E164_PATTERN.test(candidate) ? candidate : null;
}
