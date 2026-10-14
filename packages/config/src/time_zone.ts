/** True for any zone Intl accepts (IANA names and `UTC`). */
export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    // Intl throws RangeError for an unknown zone — that IS the answer.
    return false;
  }
}
