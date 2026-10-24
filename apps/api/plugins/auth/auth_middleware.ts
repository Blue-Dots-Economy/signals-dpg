import { FastifyReply, FastifyRequest } from 'fastify';
import { authConfig } from '../../src/config';
import { db } from '../../db/postgres/drizzle_config';
import { user as userTable } from '../../db/postgres/schema/auth';
import { eq } from 'drizzle-orm';
import { resolveKeycloakSession, sendAuthFailure } from './resolve_session';
import { resolveBrowserSession } from './resolve_browser_session';
import { verifyApiKey } from './verify_api_key';

/**
 * Populates `request.user` from whichever credential the caller presented,
 * tried in this order:
 *
 *   1. `x-api-key`: integrating DPGs. Verified in process against the `apikey`
 *      table by `verify_api_key.ts`.
 *   2. the `sid` cookie: a human who logged in through the BFF. This is the
 *      only channel a browser has; the tokens behind it live in Redis.
 *   3. `Authorization: Bearer <keycloak jwt>`: an integrating DPG's
 *      client-credentials token, and only that. A human token here is refused
 *      (AUTH-VULN-03/04); see `resolve_session.ts`.
 *
 * A request that resolves none of these is unauthenticated.
 *
 * Both service credentials are accepted at once as a compatibility window:
 * aggregator-dpg and voice-dpg cannot cut over in the same deploy. `x-api-key`
 * goes only once both show zero traffic on it, and the `apikey` table only
 * once signals-search stops reading it.
 */
export async function auth_middleware(
  request: FastifyRequest,
  reply: FastifyReply
) {
  // API key first, with no fallback: an invalid `x-api-key` gets 403 rather
  // than a second chance via another channel.
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

  // Browser session cookie. `fallthrough` (no cookie, or a cookie with no
  // session behind it) is not an error: the bearer path is tried next.
  const browser = await resolveBrowserSession(request, reply);
  if (browser.ok) return;
  if ('failure' in browser) return sendAuthFailure(reply, browser.failure);

  // Service bearer, the last channel. Anything it neither resolves nor fails
  // explicitly is unauthenticated.
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
