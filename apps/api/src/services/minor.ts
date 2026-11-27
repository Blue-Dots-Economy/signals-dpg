import type { NetworkConfigDocument } from '@dpg/schemas';

/**
 * Under-18 check from the stored age, a registration-time snapshot of
 * `currentYear - birthYear` with no month. Without the month a stored 18 may
 * not have turned 18 yet, so `age <= 18` counts as a minor (fail-closed).
 */
export function isMinor(age: number): boolean {
  return age <= 18;
}

/**
 * Whether a served domain routes minors through the guardian flow. Read from
 * network config at the gate; never trust a client-supplied value.
 */
export function guardianConsentRequired(
  networkConfig: NetworkConfigDocument,
  domainId: string,
): boolean {
  const domain = networkConfig.domains.find((entry) => entry.id === domainId);
  return domain?.guardian_consent_required ?? false;
}
