/**
 * One-shot handoff of an accepted-but-not-yet-persisted consent across the
 * Keycloak redirect. The accept endpoint is authenticated, so the acceptance
 * is parked in `localStorage` until `/auth/callback` has a session.
 *
 * The entry is bound to the login attempt that parked it: the body carries no
 * subject, so an abandoned entry consumed by another person's login would be
 * written as their consent. Only the callback whose `consentAttempt` matches
 * may consume it.
 *
 * Design: docs/architecture/ui-pending-consent-binding.md
 */

import type { ConsentAcceptBody } from '@dpg/schemas';

const STORAGE_KEY = 'pendingConsent';

/** How long a parked acceptance stays worth honouring; a secondary bound to the attempt binding. */
const MAX_AGE_MS = 5 * 60 * 1000;

interface StoredPendingConsent {
  body: ConsentAcceptBody;
  at: number;
  /** Opaque id of the login attempt allowed to consume this. */
  attempt: string;
}

/**
 * Mint an id for one login attempt, or null if this browser cannot do so
 * securely.
 *
 * Uses `getRandomValues` because `randomUUID` needs a secure context and the
 * app is served over plain http on LAN addresses during field testing. There is
 * no `Math.random()` fallback: on null the caller parks nothing and the user is
 * re-prompted after login.
 */
export function newConsentAttemptId(): string | null {
  try {
    if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
      return null;
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // A throwing `crypto` is treated the same as an absent one.
    return null;
  }
}

/**
 * Park the accepted consent immediately before redirecting to Keycloak.
 *
 * @param attempt - Id from {@link newConsentAttemptId}. The same id must be
 *   passed to `startBffLogin` so the callback can prove the entry belongs to
 *   the login that landed.
 * @param now - Injectable clock for tests.
 */
export function setPendingConsent(
  body: ConsentAcceptBody,
  attempt: string,
  now: number = Date.now(),
): void {
  try {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ body, at: now, attempt } satisfies StoredPendingConsent),
    );
  } catch {
    // Storage unavailable (private mode, quota). The consent gate will simply
    // re-prompt on the next login rather than the login failing.
  }
}

/**
 * Read and clear. Always clears, including on every rejection path, so an
 * entry this login may not consume is not left for the next one.
 *
 * @param expectedAttempt - The attempt id carried back by the login that just
 *   landed. `undefined` (a sign-in that parked no consent) never matches.
 * @param now - Injectable clock for tests.
 * @returns The parked acceptance, or null when nothing is pending, it belongs
 *   to a different login attempt, it is too old, or the payload is corrupt.
 */
export function takePendingConsent(
  expectedAttempt: string | undefined,
  now: number = Date.now(),
): ConsentAcceptBody | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as StoredPendingConsent;
    if (!parsed || typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS) return null;
    if (!parsed.body) return null;
    // Both ids must be present and equal, so neither an entry without an
    // `attempt` nor a plain sign-in can consume this.
    if (typeof parsed.attempt !== 'string' || parsed.attempt === '') return null;
    if (!expectedAttempt || parsed.attempt !== expectedAttempt) return null;
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
