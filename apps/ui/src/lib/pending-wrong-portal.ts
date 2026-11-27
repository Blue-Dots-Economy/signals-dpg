/**
 * One-shot handoff of a wrong-portal bounce across the Keycloak logout redirect.
 *
 * When the domain gate turns a user away, the caller signs out and then
 * navigates to `/auth/login` with `wrongPortalDomain` router state. Under
 * Keycloak, `signOut()` → `endBffSession()` does a full-page navigation to the
 * end-session endpoint, so that `navigate` never runs and Keycloak returns the
 * browser with a fresh document and no router state.
 *
 * The reason is therefore parked in localStorage (read-once, like
 * `pending-consent.ts`) and surfaced by `<WrongPortalToast />`, which is
 * mounted app-wide so it does not depend on the post-logout landing route.
 */

const STORAGE_KEY = 'pendingWrongPortal';

/**
 * How long a parked bounce stays worth showing. Parking to landing is one
 * Keycloak round trip, so anything older is from an abandoned logout and must
 * not surface as an unexplained error on a later visit.
 */
const MAX_AGE_MS = 5 * 60 * 1000;

interface PendingWrongPortal {
  domain: string;
  at: number;
}

/**
 * Park the blocked domain immediately before signing out, since `signOut()`
 * may never return control.
 *
 * @param domain - The domain the user already holds a profile in.
 * @param now - Injectable clock for tests.
 */
export function setPendingWrongPortal(domain: string, now: number = Date.now()): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ domain, at: now } satisfies PendingWrongPortal));
  } catch {
    // Storage unavailable (private mode, quota). The bounce still happens;
    // only the explanation is lost.
  }
}

/**
 * Read and clear the parked bounce.
 *
 * @param now - Injectable clock for tests.
 * @returns The blocked domain, or null when there is no fresh bounce to report.
 */
export function takePendingWrongPortal(now: number = Date.now()): string | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as PendingWrongPortal;
    if (!parsed || typeof parsed.domain !== 'string' || parsed.domain === '') return null;
    if (typeof parsed.at !== 'number' || now - parsed.at > MAX_AGE_MS) return null;
    return parsed.domain;
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
