import type { FastifyBaseLogger } from 'fastify';
import { destroySession, readSession } from '@/services/auth/browser_session';
import { getKeycloakAdminClient } from '@/services/auth/keycloak_admin_instance';
import { idTokenClaim } from '@/services/auth/oidc_exchange';

/**
 * End a browser session here AND the Keycloak SSO session behind it, without
 * sending the browser through Keycloak's logout page.
 *
 * Used when a different person is about to log in in the same browser (a
 * partner-portal SSO arrival). Clearing only our `sid` is not enough: Keycloak
 * would still hold the previous user's SSO session, and logging a different
 * user into it fails with USER_CONFLICT (see the `prompt` note in
 * oidc_exchange.test.ts). The Keycloak session id is the `sid` claim of the id
 * token we stored at login.
 *
 * Best-effort on the Keycloak side: a failure is logged, never thrown.
 */
export async function endBrowserSessionEverywhere(
  sessionId: string,
  log: FastifyBaseLogger
): Promise<void> {
  const session = await readSession(sessionId);
  await destroySession(sessionId);

  await endKeycloakSession(idTokenClaim(session?.idToken, 'sid'), log);
}

/**
 * End one Keycloak user session by its `sid`. Best-effort: a missing sid or
 * admin client, or a Keycloak error, is logged and swallowed — callers are on
 * a login path that must still answer the browser.
 */
export async function endKeycloakSession(
  keycloakSessionId: string | null,
  log: FastifyBaseLogger
): Promise<void> {
  const admin = getKeycloakAdminClient();
  if (!keycloakSessionId || !admin) return;

  try {
    await admin.deleteSession(keycloakSessionId);
  } catch (err) {
    log.warn({ err }, 'could not end a Keycloak session');
  }
}
