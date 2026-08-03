/**
 * One-shot handoff of the domain + age a NEW user picked on the Keycloak signup
 * form, across the Keycloak redirect.
 *
 * Why this exists in addition to the server-side stash: `POST /api/v1/auth/signup`
 * already parks these in Redis (`services/auth/signup_extras.ts`) for
 * provisioning to apply at first login, but that stash has a **30-minute TTL and
 * fails silently**. A user who leaves Keycloak's OTP screen open too long, or
 * hits a Redis blip, lands with `domains = null` and `age = null` — and a null
 * age on a guardian-gated domain is fail-closed server-side
 * (`item_service.ts` `guardianGateBlocksGoLive`), so they cannot publish a
 * profile and have no in-app way to fix it.
 *
 * The better-auth flow never had that problem: it carried these in router state
 * to `otp-page`, which wrote them over an authenticated session with no TTL.
 * This restores that durability for the Keycloak flow — the callback performs
 * the same authenticated writes. The Redis stash stays as the fast path; the two
 * are idempotent together (same domain, same age).
 *
 * That is gap G3 of
 * `docs/superpowers/plans/2026-07-31-replace-better-auth-with-keycloak.md`.
 *
 * Read-once, exactly like `pending-consent.ts`: the callback clears it as soon
 * as it is consumed, so a stale signup can never be replayed onto a later,
 * unrelated login.
 */

import type { SignupExtras } from '@/lib/signup-domain';

const STORAGE_KEY = 'pendingSignupExtras';

/** Park the signup form's domain/age immediately before redirecting to Keycloak. */
export function setPendingSignupExtras(extras: SignupExtras): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(extras));
  } catch {
    // Storage unavailable (private mode, quota). The server-side Redis stash is
    // still in play, so this degrades to today's behaviour rather than failing.
  }
}

/** Read and clear. Returns null when this login is not a fresh signup. */
export function takePendingSignupExtras(): SignupExtras | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as SignupExtras;
    // A payload with no domain is unusable — the domain is what the writes key
    // on — so treat it as absent rather than calling the API with undefined.
    if (!parsed || typeof parsed.domain !== 'string' || parsed.domain === '') {
      return null;
    }
    return parsed;
  } catch {
    // Corrupt payload — drop it rather than retrying forever.
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    return null;
  }
}

export function clearPendingSignupExtras(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
