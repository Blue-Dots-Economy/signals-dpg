import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';

const MeResponse = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  role: z.string().nullable(),
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
      });
    },
  });
};
