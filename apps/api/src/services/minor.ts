import type { NetworkConfigDocument } from '@dpg/schemas';

/**
 * Under-18 check from the stored age (#331). Age is a snapshot captured at
 * registration (derived from the birth year: `currentYear - birthYear`, no
 * month). A minor is `age <= 18`: with no month we can't confirm someone in
 * their 18th year has had their birthday, so the whole boundary year is treated
 * as u18 — fail-closed. Adult only at 19+ by this rule.
 */
export function isMinor(age: number): boolean {
  return age <= 18;
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
