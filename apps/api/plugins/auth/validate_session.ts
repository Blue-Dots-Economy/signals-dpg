import { authInstance } from '../../src/routes/auth/create_auth';
import { FastifyRequest, FastifyReply } from 'fastify';
import { resolveKeycloakSession, sendAuthFailure } from './resolve_session';

/**
 * Session-only guard (no apikey path). Goes through the same
 * `resolveKeycloakSession` helper as `auth_middleware`, so the two cannot
 * disagree about which provider a request belongs to.
 */
export async function validate_session(
  request: FastifyRequest,
  reply: FastifyReply
) {
  const keycloak = await resolveKeycloakSession(request);
  if (keycloak.ok) return;
  if ('failure' in keycloak) return sendAuthFailure(reply, keycloak.failure);

  const session = await authInstance.api.getSession({
    headers: new Headers(request.headers as Record<string, string>),
  });

  if (!session?.user) {
    return reply.status(401).send({
      code: 'Session_Err',
      error: 'Unauthorized',
      message: 'Missing/invalid authentication',
    });
  }

  request.user = session.user;
}
