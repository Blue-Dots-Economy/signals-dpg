import { FastifyReply, FastifyRequest } from 'fastify';

/**
 * The authenticated user's id, or `undefined` after sending a 401.
 *
 * Replaces the `if (!request.user?.id) return reply.code(401).send(...)` guard
 * that was hand-copied into 20 route handlers. The response body is unchanged:
 * `{ error: 'UNAUTHORIZED', message }`, with `message` defaulting to the
 * wording 20 of those handlers already used. The six routes that appended a
 * route-specific clause ("…to fetch events") pass it explicitly, so every
 * body stays byte-for-byte what it was.
 *
 * Usage — the `return reply` is what stops the handler:
 *
 *   const userId = requireAuthedUser(request, reply);
 *   if (!userId) return reply;
 */
export function requireAuthedUser(
  request: FastifyRequest,
  reply: FastifyReply,
  message = 'Authenticated user is required'
): string | undefined {
  const userId = request.user?.id;
  if (userId) return userId;

  reply.code(401).send({ error: 'UNAUTHORIZED', message });
  return undefined;
}
