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

/**
 * The birth year that turns 18 in the given year — the only cohort where the
 * year alone can't decide U18 (they could be 17 or 18 depending on birthday).
 * Used to conditionally ask for the birth month. (#331)
 */
export function boundaryBirthYear(now: Date = new Date()): number {
  return now.getFullYear() - 18;
}

/**
 * Build a birth date from year (+ optional month) for U18 gating (#331). We
 * only ever collect year — and month for the boundary year — never the day.
 * The stored day is the LAST day of the month (month defaults to December when
 * unknown), so the computed 18th birthday is the latest possible in that
 * month: fail-closed (a boundary-year person stays a minor until end of the
 * month/year). Reuses the existing `date_of_birth` date column; extensible to
 * a real day later. Local date (see `toDateOnly` on the tz rationale).
 *   new Date(year, mm, 0) === last day of 1-indexed month `mm`.
 */
export function buildYearMonthDob(year: number, month?: number): Date {
  return new Date(year, month ?? 12, 0);
}

/**
 * Serialize a picked calendar date as a LOCAL date-only `yyyy-mm-dd`. The
 * calendar hands back a Date at local midnight; `toISOString()` would convert
 * to UTC and, east of Greenwich (e.g. IST +5:30), roll it back a day — which at
 * the 18th-birthday boundary flips the minor/adult routing. Emit the local
 * calendar day so what the user picked is what the server stores.
 */
export function toDateOnly(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
