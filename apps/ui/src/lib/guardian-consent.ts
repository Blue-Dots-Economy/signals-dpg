import axios from 'axios';
import { toast } from 'sonner';
import type { TFunction } from 'i18next';
import type { DotNetworkSchema } from '@/engine/types';

/**
 * Whether a domain routes minors through the U18 guardian consent flow.
 * Mirrors apps/api/src/services/minor.ts; the server is authoritative and this
 * only decides which UI to render.
 */
export function isGuardianConsentRequiredDomain(
  network: DotNetworkSchema,
  domainId: string,
): boolean {
  return network.domains.find((d) => d.id === domainId)?.guardian_consent_required ?? false;
}

/**
 * Age from a birth year. The UI collects only the year, so age is
 * `currentYear - birthYear`, the same rule the server applies.
 */
export function ageFromBirthYear(year: number, now: Date = new Date()): number {
  return now.getFullYear() - year;
}

/**
 * Mirrors the server's `isMinor` (apps/api/src/services/minor.ts): `age <= 18`,
 * so the whole boundary year counts as U18 (fail-closed, no birth month). Only
 * decides whether to render the pre-auth guardian step; the
 * /u18/signup/guardian route rejects an adult with NOT_A_MINOR.
 */
export function isMinorFromAge(age: number): boolean {
  return age <= 18;
}

/**
 * Toasts a guardian OTP-send failure: 429 and 503 get shared copy, anything
 * else the caller's fallback message.
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
