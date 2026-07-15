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
 * (apps/api/src/services/minor.ts). Conservative rounding: a ward is a minor
 * through the WHOLE birth-month of their 18th year, becoming an adult on the
 * 1st of the following month ("keep-minor-longer"). Used ONLY to decide
 * whether to render the pre-auth guardian step at signup; the server remains
 * authoritative (the /u18/signup/guardian route re-checks and rejects an
 * adult with NOT_A_MINOR).
 */
export function isMinorFromBirth(
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
  const adultThreshold = Date.UTC(adultYear, adultMonth - 1, 1);
  return now.getTime() < adultThreshold;
}
