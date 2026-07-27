import axios from 'axios';
import { toast } from 'sonner';
import type { TFunction } from 'i18next';
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
 * Age (years) from a birth year (#331). The UI only ever collects the birth
 * YEAR, never a month or day, so age is a plain `currentYear - birthYear`
 * snapshot — the same rule the server applies at storage.
 */
export function ageFromBirthYear(year: number, now: Date = new Date()): number {
  return now.getFullYear() - year;
}

/**
 * Derived under-18 check — mirrors the server's `isMinor`
 * (apps/api/src/services/minor.ts): a minor is `age <= 18`. With no birth month
 * the whole boundary year is treated as u18 (fail-closed). Used ONLY to decide
 * whether to render the pre-auth guardian step at signup; the server remains
 * authoritative (the /u18/signup/guardian route re-checks and rejects an adult
 * with NOT_A_MINOR).
 */
export function isMinorFromAge(age: number): boolean {
  return age <= 18;
}

/**
 * Toast the standard guardian OTP-send failure: rate-limited (429) and
 * confirmation-unavailable (503) map to shared copy; anything else falls back
 * to the caller-supplied message. Shared by the guardian form + OTP step so the
 * 429/503 branches aren't copied per site.
 */
export function toastGuardianSendError(
  err: unknown,
  t: TFunction,
  fallback: { key: string; def: string },
): void {
  const status = axios.isAxiosError(err) ? err.response?.status : undefined;
  if (status === 429) {
    toast.error(t('u18.guardian_error_rate_limited', 'Too many attempts. Please try again shortly.'));
  } else if (status === 503) {
    toast.error(
      t('u18.guardian_error_otp_unavailable', "Guardian confirmation isn't available on this instance right now."),
    );
  } else {
    toast.error(t(fallback.key, fallback.def));
  }
}
