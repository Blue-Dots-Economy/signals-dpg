import type { FastifyRequest, FastifyReply } from 'fastify';

/**
 * Fastify preHandler requiring the authenticated caller's `role` to be
 * `admin` — the role better-auth's admin plugin grants (see
 * `adminRoles: ['admin']` in `packages/auth/src/config.ts`), the only
 * admin-tier role value that already exists in this codebase's role
 * vocabulary. Must run after `auth_middleware`/`auth_middleware_if_enabled`
 * so `request.user` is populated.
 */
export const require_admin_role = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  if (request.user?.role !== 'admin') {
    request.log.warn(
      {
        operation: 'require_admin_role',
        user_id: request.user?.id,
        role: request.user?.role,
      },
      'Forbidden: admin role required',
    );
    return reply.code(403).send({
      error: 'FORBIDDEN',
      message: 'Admin role required',
    });
  }
};
