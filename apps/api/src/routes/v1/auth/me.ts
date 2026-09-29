import z from '@dpg/schemas';
import type { FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { SESSION_COOKIE } from '@api/plugins/auth/resolve_browser_session';
import { readSession, updateSession } from '@/services/auth/browser_session';
import { claimAppFirstLogin } from '@/services/auth/app_first_login';

const MeResponse = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string().nullable(),
  /**
   * True only in the person's first browser session in the app (not the
   * first time the account was created — voice and aggregators create users
   * without a browser). The UI plays its welcome tours then. Always false for
   * service credentials.
   */
  first_login: z.boolean(),
});

const ErrorResponse = z.object({
  code: z.string(),
  error: z.string(),
  message: z.string(),
});

/**
 * "Who am I", resolved from the local `user` mirror.
 *
 * Added for the Keycloak login flow (Build 2 of the migration design): after
 * the OIDC redirect the UI holds an access token but knows nothing about the
 * signals-side user, and better-auth's `/api/auth/get-session` is not on that
 * path. Hitting this endpoint both establishes the UI's session object and —
 * because it runs the normal auth middleware — is what triggers first-login
 * provisioning of the mirror.
 *
 * Deliberately returns the mirror's view, not the token's claims: `role` and
 * the resolved id are signals-local, and the UI should render what the API
 * will actually authorize.
 *
 * Note this group has no group-level auth hook (see apps/api/CLAUDE.md), so
 * the route declares its own preHandler.
 */
export const auth_me: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/me',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['auth'],
      response: { 200: MeResponse, 401: ErrorResponse },
    },
    handler: async (request, reply) => {
      // Reachable when AUTH_MIDDLEWARE_ENABLED=false (the local dev / seed-script
      // kill switch) — the preHandler is skipped, so there is no user to report.
      if (!request.user?.id) {
        return reply.code(401).send({
          code: 'UNAUTHORIZED',
          error: 'Unauthorized',
          message: 'Missing or invalid authentication',
        });
      }

      return reply.code(200).send({
        id: request.user.id,
        email: request.user.email ?? '',
        name: request.user.name ?? '',
        role: request.user.role ?? null,
        first_login: await firstLoginOf(request),
      });
    },
  });
};

/**
 * Whether this request's browser session is the person's first in the app.
 * Decided on the session's first ask and cached on the session. Only a
 * browser session counts: an `x-api-key` or client-credentials caller (voice,
 * aggregator) is never a first login. A failure answers false — missing a
 * welcome tour beats replaying it on every visit.
 */
async function firstLoginOf(request: FastifyRequest): Promise<boolean> {
  const sessionId = request.cookies?.[SESSION_COOKIE];
  if (!sessionId || typeof request.headers['x-api-key'] === 'string' || request.service_client_id) {
    return false;
  }
  try {
    const session = await readSession(sessionId);
    if (!session) return false;
    if (session.firstLogin !== undefined) return session.firstLogin;
    const first = await claimAppFirstLogin(request.user.id);
    await updateSession(sessionId, { firstLogin: first });
    return first;
  } catch (err) {
    request.log.warn({ err, user_id: request.user.id }, 'first-login check failed — treated as not first');
    return false;
  }
}
