// The post-login landing decision, shared by the Keycloak OIDC callback
// (`pages/auth/oidc-callback-page.tsx`) and the legacy OTP page
// (`pages/auth/otp-page.tsx`), so login paths cannot drift.
//
// Separate from `post-login-route.ts` because `login-profiles.ts` imports that
// module's `ProfileLite` type; adding the fetch there would create an import
// cycle.

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
 * The profile redirect takes precedence over `fallback`: a user with no
 * completed profile cannot act on a deep link anyway.
 *
 * Fails open: any error resolves to `fallback`, so the profile check never
 * blocks sign-in.
 *
 * Call only after the session is established. `fetchMyProfilesLite` is an
 * authenticated read; calling it earlier would 401 and silently fail open.
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
