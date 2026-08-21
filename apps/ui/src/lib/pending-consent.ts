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
 * login — BUT read-once only protects against replaying it onto the SAME
 * person's later logins. It does nothing if the round trip is simply never
 * finished: `createAccountAndSignIn` writes this, then hands off to Keycloak's
 * hosted pages, a full-page navigation this app has no visibility into. If
 * that browser tab is abandoned there (closed, walked away from, the person
 * gives up) the entry sits in `localStorage` — which, unlike router state or
 * `sessionStorage`, is shared by every tab and survives indefinitely — until
 * SOME OTHER Keycloak callback on that device finds it and `acceptConsent`s it
 * onto whichever unrelated person's session happens to complete next. That
 * person never saw the documents this consent claims they accepted.
 *
 * Guarded exactly like `pending-wrong-portal.ts`'s abandoned-logout case,
 * which this mirrors: a timestamp, checked on read. The gap between parking
 * and landing is one Keycloak round-trip (seconds); anything older belongs to
 * an abandoned attempt and must not be handed to whoever logs in next.
 */

import type { ConsentAcceptBody } from '@dpg/schemas';

const STORAGE_KEY = 'pendingConsent';

/** How long a parked acceptance stays worth honouring. See module doc. */
const MAX_AGE_MS = 5 * 60 * 1000;

interface StoredPendingConsent {
  body: ConsentAcceptBody;
  at: number;
}

/**
 * Park the accepted consent immediately before redirecting to Keycloak.
 *
 * @param body - The consent acceptance to write once the session exists.
 * @param now - Injectable clock for tests.
 */
export function setPendingConsent(body: ConsentAcceptBody, now: number = Date.now()): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ body, at: now } satisfies StoredPendingConsent));
  } catch {
    // Storage unavailable (private mode, quota). The consent gate will simply
    // re-prompt on the next login rather than the login failing.
  }
}

/**
 * Read and clear.
 *
 * @param now - Injectable clock for tests.
 * @returns The parked acceptance, or null when there is nothing pending, it
 *   is too old to trust (see module doc), or the payload is corrupt.
 */
export function takePendingConsent(now: number = Date.now()): ConsentAcceptBody | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as StoredPendingConsent;
    if (!parsed || typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS) return null;
    if (!parsed.body) return null;
    return parsed.body;
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
