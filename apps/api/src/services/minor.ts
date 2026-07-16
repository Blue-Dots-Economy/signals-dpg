import type { NetworkConfigDocument } from '@dpg/schemas';

/**
 * Derived under-18 check (U18 spec D2). Birth is the ward's full date of birth,
 * stored on `user.date_of_birth`. Adult from the 18th birthday onward; minor
 * before it. `is_minor` is never stored — recompute from the DOB on every read.
 */
export function isMinor(dateOfBirth: Date, now: Date = new Date()): boolean {
  const adultThreshold = new Date(dateOfBirth);
  adultThreshold.setFullYear(adultThreshold.getFullYear() + 18);
  return now.getTime() < adultThreshold.getTime();
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
