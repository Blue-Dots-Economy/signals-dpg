import type { DotNetworkSchema } from '@/engine/types';

/**
 * Whether a served domain routes minors through the U18 guardian consent flow
 * (Phase 6). Mirrors the server-side check in apps/api/src/services/minor.ts —
 * the server remains authoritative; this only decides which UI to render.
 */
export function isGuardianConsentRequiredDomain(
  network: DotNetworkSchema,
  domainId: string,
): boolean {
  return network.domains.find((d) => d.id === domainId)?.guardian_consent_required ?? false;
}

/**
 * Derived under-18 check — mirrors the server's `isMinor`
 * (apps/api/src/services/minor.ts): adult from the 18th birthday onward. Used
 * ONLY to decide whether to render the pre-auth guardian step at signup; the
 * server remains authoritative (the /u18/signup/guardian route re-checks and
 * rejects an adult with NOT_A_MINOR).
 */
export function isMinorFromDate(dateOfBirth: Date, now: Date = new Date()): boolean {
  const adultThreshold = new Date(dateOfBirth);
  adultThreshold.setFullYear(adultThreshold.getFullYear() + 18);
  return now.getTime() < adultThreshold.getTime();
}
