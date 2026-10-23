/**
 * Removes auth tokens older builds stored in browser storage. The session now
 * rides an httpOnly cookie, but tokens already in `localStorage` would stay
 * readable by any script on the origin until cleared.
 *
 * Two legacy writers: the app's own `auth_token` key, and `oidc-client-ts`,
 * which stored the refresh token under `oidc.user:<authority>:<client>`
 * (matched by prefix because it varies per deployment).
 *
 * Runs on boot; cheap, and removable once every active browser has run it.
 */

const LEGACY_TOKEN_KEY = 'auth_token';
const LEGACY_OIDC_PREFIX = 'oidc.';

export function purgeLegacyAuthStorage(): void {
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
    sessionStorage.removeItem(LEGACY_TOKEN_KEY);

    for (const store of [localStorage, sessionStorage]) {
      // Collect first: removing while iterating reindexes the store and skips entries.
      const stale = Object.keys(store).filter((key) => key.startsWith(LEGACY_OIDC_PREFIX));
      for (const key of stale) store.removeItem(key);
    }
  } catch {
    // Storage can be unavailable (Safari private mode); never block boot.
  }
}
