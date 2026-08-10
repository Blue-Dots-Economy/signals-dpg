import type { FastifyInstance } from 'fastify';

/**
 * Marks every authenticated response `no-store` so a shared proxy cache or
 * browser history never retains PII-bearing payloads (security assessment
 * issue #11). `request.user` is only populated by `auth_middleware` on a
 * successful apikey/session check, so this is a safe global signal — unlike
 * auth wiring itself, cache-control is response-shape-agnostic and doesn't
 * need the per-route opt-in convention the rest of this app uses.
 */
export function registerSecurityHeaders(app: FastifyInstance): void {
  app.addHook('onSend', async (request, reply, payload) => {
    if (request.user?.id) {
      reply.header('Cache-Control', 'private, no-store');
      reply.header('Pragma', 'no-cache');
    }
    return payload;
  });
}
