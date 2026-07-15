import type { NetworkConfigDocument } from '@dpg/schemas';

/**
 * Derived under-18 check (U18 spec D2/D3). Birth data is year+month only.
 * Conservative rounding: a ward is a minor through the WHOLE birth-month of
 * their 18th year, becoming an adult on the 1st of the following month
 * ("keep-minor-longer" — never treat a real minor as an adult). `is_minor`
 * is never stored; recompute from the stored year+month on every read.
 */
export function isMinor(
  birthYear: number,
  birthMonth: number, // 1-12
  now: Date = new Date(),
): boolean {
  let adultYear = birthYear + 18;
  let adultMonth = birthMonth + 1; // 1-12 → may be 13
  if (adultMonth > 12) {
    adultMonth = 1;
    adultYear += 1;
  }
  // First instant of the month the ward becomes an adult (UTC, day 1).
  const adultThreshold = Date.UTC(adultYear, adultMonth - 1, 1);
  return now.getTime() < adultThreshold;
}

/**
 * Whether a served domain routes minors through the guardian flow (U18 D8).
 * Read server-side at the gate; never trust a client-supplied value.
 */
export function guardianConsentRequired(
  networkConfig: NetworkConfigDocument,
  domainId: string,
): boolean {
  const domain = networkConfig.domains.find((entry) => entry.id === domainId);
  return domain?.guardian_consent_required ?? false;
}
