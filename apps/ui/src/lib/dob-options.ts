/**
 * Shared birth-month/year option builders for the U18 date-of-birth capture
 * UI. Used by the first-login guardian flow's DOB step (`u18/dob-step.tsx`)
 * and the Signals self-signup form (`pages/auth/login-page.tsx`) so both
 * surfaces offer the exact same month labels and year range — we only ever
 * collect month + year (no day), never a future year.
 */
export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/**
 * A birth year anywhere from 100 years ago through this year, descending
 * (most recent first) so a signup form's default scroll position is near
 * plausible adult birth years.
 */
export function buildYearOptions(now: Date = new Date()): number[] {
  const currentYear = now.getFullYear();
  const years: number[] = [];
  for (let y = currentYear; y >= currentYear - 100; y--) years.push(y);
  return years;
}
