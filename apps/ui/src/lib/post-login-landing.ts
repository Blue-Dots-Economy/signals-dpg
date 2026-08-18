// The post-login landing decision, shared by BOTH login flows: better-auth's
// OTP page (`pages/auth/otp-page.tsx`) and the Keycloak OIDC callback
// (`pages/auth/oidc-callback-page.tsx`).
//
// #376 introduced the redirect but wired it only into the OTP page, so it never
// ran under `AUTH_PROVIDER=keycloak` (#558). It lives here — rather than being
// called twice — so a future third login path cannot silently drift again.
//
// Kept separate from `post-login-route.ts` on purpose: that module is pure (no
// imports) and independently unit-tested, and `login-profiles.ts` already
// imports its `ProfileLite` type, so folding the fetch in there would create an
// import cycle.

import { fetchMyProfilesLite } from '@/lib/login-profiles';
import { resolvePostLoginRedirect } from '@/lib/post-login-route';
import { getStoredActiveProfileId } from '@/lib/active-profile';

/**
 * Resolves where to send a user immediately after login.
 *
 * Returns the profile create/edit path when they have no *completed* profile
 * (none at all, or every profile still `draft`), otherwise `fallback` — the
 * caller's `redirectTo` / `returnTo`, or home.
 *
 * The profile redirect deliberately takes precedence over `fallback`: a user
 * with no completed profile can't act on a deep link anyway.
 *
 * **Fail-open by contract.** Any error resolving the user's profiles resolves
 * to `fallback` rather than throwing, so the profile check can never block
 * sign-in. Callers must not wrap this expecting it to throw.
 *
 * **Call only after the session is established.** `fetchMyProfilesLite` is an
 * authenticated read; calling it earlier would 401, fail open, and look exactly
 * like the redirect not being wired at all.
 */
export async function resolvePostLoginLanding(
  networkId: string,
  fallback: string,
): Promise<string> {
  try {
    const profiles = await fetchMyProfilesLite(networkId);
    const redirect = resolvePostLoginRedirect(profiles, getStoredActiveProfileId(networkId));
    return redirect?.path ?? fallback;
  } catch {
    // Never block sign-in on the profile check.
    return fallback;
  }
}
