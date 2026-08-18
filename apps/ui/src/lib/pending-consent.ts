/**
 * One-shot handoff of an accepted-but-not-yet-persisted consent across the
 * Keycloak redirect.
 *
 * `POST /api/v1/consent/accept` is **authenticated**, so a consent accepted on
 * the login screen can only be written once the user actually has a session.
 * The better-auth flow solves this by carrying the pending acceptance in router
 * state from `login-page` to `otp-page`, which calls `acceptConsent` after the
 * OTP verifies.
 *
 * The Keycloak flow can't use router state: signing in leaves the SPA entirely
 * for Keycloak's own pages, so in-memory and history state are both gone by the
 * time we return to `/auth/callback`. Storage survives that round trip.
 *
 * Read-once, like `signup-domain.ts`: the callback clears it as soon as it is
 * consumed, so a stale acceptance can never be replayed onto a later, unrelated
 * login.
 */

import type { ConsentAcceptBody } from '@dpg/schemas';

const STORAGE_KEY = 'pendingConsent';

export function setPendingConsent(body: ConsentAcceptBody): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(body));
  } catch {
    // Storage unavailable (private mode, quota). The consent gate will simply
    // re-prompt on the next login rather than the login failing.
  }
}

/** Read and clear. Returns null when there is nothing pending. */
export function takePendingConsent(): ConsentAcceptBody | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    return JSON.parse(raw) as ConsentAcceptBody;
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

export function clearPendingConsent(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
