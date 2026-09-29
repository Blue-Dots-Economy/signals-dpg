import type { FastifyBaseLogger } from 'fastify';
import { provisionUserFromClaims } from '@/services/auth/provisioning';
import { getSsoProfileMapping } from '@/services/auth/sso/registry';
import { bootstrapSsoProfile } from '@/services/auth/sso/sso_profile_bootstrap';
import { takeEntry } from '@/services/auth/sso/sso_store';
import { verifyKeycloakToken } from '@/utils/keycloak_token';

/**
 * The SSO half of `/session/callback`, run once Keycloak has issued tokens for
 * a login that started at `/sso/login`.
 *
 *   1. read back (and consume) the verified partner identity for this flow
 *   2. check Keycloak logged in the account the SSO API asked for — the
 *      `preferred_username` it put in the id_token. Only then does the
 *      partner's verification vouch for this account.
 *   3. create the local user even on a gated instance (the partner onboarded
 *      this person), with every other provisioning gate intact
 *   4. create the draft profile on first login
 *
 * Never throws. Returns `wrong-account` only when Keycloak logged in someone
 * other than the account the SSO API vouched for — the caller must then refuse
 * the login, because the person at the browser is not who the partner said.
 * Every other failure returns `skipped`: the session is still
 * created, and ordinary provisioning runs on the user's first request.
 */
export type SsoCompletion = 'completed' | 'skipped' | 'wrong-account';

export async function completeSsoLogin(
  sso: { provider: string; handle: string },
  accessToken: string,
  log: FastifyBaseLogger
): Promise<SsoCompletion> {
  try {
    const entry = await takeEntry(sso.handle);
    if (!entry) {
      log.warn({ provider: sso.provider }, 'sso: callback without a live entry');
      return 'skipped';
    }

    const verified = await verifyKeycloakToken(accessToken);
    if (!verified.ok) {
      log.warn({ code: verified.code }, 'sso: callback token did not verify');
      return 'skipped';
    }

    const loggedInAs = verified.claims.preferred_username?.toLowerCase();
    if (loggedInAs !== entry.preferredUsername.toLowerCase()) {
      log.warn(
        { provider: sso.provider, subject: entry.identity.subject },
        'sso: Keycloak logged in a different account than the SSO API vouched for'
      );
      return 'wrong-account';
    }

    const provisioned = await provisionUserFromClaims(verified.claims, log, {
      allowSignup: true,
    });
    if (!provisioned.ok) {
      log.warn({ code: provisioned.code }, 'sso: provisioning refused the SSO user');
      return 'skipped';
    }

    const mapping = getSsoProfileMapping(sso.provider);
    if (mapping) {
      await bootstrapSsoProfile(provisioned.user.id, entry.identity, mapping, log);
    }
    return 'completed';
  } catch (err) {
    log.error({ err, provider: sso.provider }, 'sso: completing the login failed');
    return 'skipped';
  }
}
