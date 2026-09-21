import { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig } from '../../src/config';
import { db } from '../../db/postgres/drizzle_config';
import { user as userTable } from '../../db/postgres/schema/auth';
import { eq } from 'drizzle-orm';
import { resolveKeycloakSession, sendAuthFailure } from './resolve_session';
import { resolveBrowserSession } from './resolve_browser_session';
import { verifyApiKey } from './verify_api_key';

/**
 * Populates `request.user` from whichever credential the caller presented.
 *
 * There are three ways in, tried in this order:
 *
 *   1. `x-api-key` — integrating DPGs, today's service auth. Verified in
 *      process against the `apikey` table by `verify_api_key.ts` (#517 removed
 *      better-auth; the table, the hash and the wire contract are unchanged).
 *   2. the `sid` cookie — a human who logged in through the BFF. This is the
 *      only channel a browser has; the tokens behind it live in Redis.
 *   3. `Authorization: Bearer <keycloak jwt>` — an integrating DPG's
 *      client-credentials token (the replacement for #1), and ONLY that. A
 *      human token here is refused (AUTH-VULN-03/04); see `resolve_session.ts`.
 *
 * The fourth channel — a better-auth session — is gone with the library (#517).
 * Keycloak is now the only identity provider, so a request that resolves none
 * of the above is simply unauthenticated.
 *
 * **Both service credentials are still accepted at once, on purpose.** That is
 * the compatibility window (§5): aggregator-dpg and voice-dpg live in other
 * repos and cannot cut over in the same deploy as this one. `x-api-key` is
 * removed only once both confirm zero traffic on the old path — and, for the
 * `apikey` table itself, once signals-search stops reading it (#516).
 */
export async function auth_middleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  /**
   * API KEY AUTH (highest priority)
   *
   * Still first, and still no fallback on failure: a caller that sends an
   * invalid `x-api-key` gets 403 rather than a second chance via bearer. That
   * precedence is unchanged from before the dual-accept window so a partner
   * mid-migration sees identical behaviour on the old path.
   */
  const apiKey = request.headers['x-api-key'];

  if (typeof apiKey === 'string') {
    const verified = await verifyApiKey(apiKey);

    if (!verified.valid) {
      return reply.status(403).send({
        code: 'INVALID_API_KEY',
        error: 'Forbidden',
        message: 'Invalid API key provided',
      });
    }

    const keyUserId = verified.userId;

    if (keyUserId) {
      const [owner] = await db
        .select({
          id: userTable.id,
          email: userTable.email,
          name: userTable.name,
          role: userTable.role,
        })
        .from(userTable)
        .where(eq(userTable.id, keyUserId))
        .limit(1);

      request.user = owner
        ? {
            id: owner.id,
            email: owner.email ?? '',
            name: owner.name,
            role: owner.role,
          }
        : ({ id: keyUserId } as typeof request.user);
    }

    return;
  }

  /**
   * BROWSER SESSION (cookie) — tried before the bearer path.
   *
   * A `sid` cookie means a human logged in through the BFF, so the token lives
   * in Redis rather than in the page. `fallthrough` means no cookie was sent,
   * which is not an error: service callers and anonymous requests take the
   * paths below.
   */
  const browser = await resolveBrowserSession(request, reply);
  if (browser.ok) return;
  if ('failure' in browser) return sendAuthFailure(reply, browser.failure);

  /**
   * SERVICE BEARER — the last channel.
   *
   * `resolveKeycloakSession` used to be able to return `fallthrough`, meaning
   * "AUTH_PROVIDER=betterauth, let the library handle it". With better-auth
   * gone (#517) there is nothing to fall through to, so anything it does not
   * resolve or explicitly fail is unauthenticated.
   */
  const keycloak = await resolveKeycloakSession(request);
  if (keycloak.ok) return;
  if ('failure' in keycloak) return sendAuthFailure(reply, keycloak.failure);

  return reply.status(401).send({
    code: 'UNAUTHORIZED',
    error: 'Unauthorized',
    message: 'Missing or invalid authentication',
  });
}

export async function auth_middleware_if_enabled(
  request: FastifyRequest,
  reply: FastifyReply
) {
  if (!authConfig.middleware_enabled) {
    return;
  }

  return auth_middleware(request, reply);
}
