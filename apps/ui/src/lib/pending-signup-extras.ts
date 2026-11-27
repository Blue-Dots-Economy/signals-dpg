/**
 * One-shot handoff of the domain + age a new user picked on the Keycloak signup
 * form, across the Keycloak redirect.
 *
 * `POST /api/v1/auth/signup` also stashes these in Redis
 * (`services/auth/signup_extras.ts`) for first-login provisioning, but that
 * stash has a 30-minute TTL and fails silently. A user who misses it lands with
 * no domain and no age, and a null age on a guardian-gated domain blocks
 * go-live server-side (`guardianGateBlocksGoLive`) with no in-app fix. The
 * callback therefore repeats the writes over the authenticated session; the
 * two paths are idempotent together.
 *
 * Read-once, like `pending-consent.ts`, so a stale signup is never replayed
 * onto a later login.
 */

import type { SignupExtras } from '@/lib/signup-domain';

const STORAGE_KEY = 'pendingSignupExtras';

/** Park the signup form's domain/age immediately before redirecting to Keycloak. */
export function setPendingSignupExtras(extras: SignupExtras): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(extras));
  } catch {
    // Storage unavailable (private mode, quota). The server-side Redis stash
    // still applies.
  }
}

/** Read and clear. Returns null when this login is not a fresh signup. */
export function takePendingSignupExtras(): SignupExtras | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    localStorage.removeItem(STORAGE_KEY);
    const parsed = JSON.parse(raw) as SignupExtras;
    // The domain is what the writes key on, so a payload without one is unusable.
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
