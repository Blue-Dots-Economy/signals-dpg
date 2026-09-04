import { authInstance } from '@/routes/auth/create_auth';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const AuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    method: ['GET', 'POST', 'OPTIONS'],
    schema: { hide: true },
    url: '/api/auth/*',
    // No `config.rateLimit`: @fastify/rate-limit is not installed or registered,
    // so Fastify would silently ignore it — a previous one here read as
    // protection while enforcing nothing. This path is limited at the ingress
    // (`/api/auth` is an apiRateLimit group, and unified-otp/request carries a
    // tighter otpRateLimit). Don't add one without registering the plugin.

    handler: async (request, reply) => {
      if (request.method === 'OPTIONS') {
        return reply.status(204).send();
      }

      try {
        const url = new URL(request.url, `http://${request.headers.host}`);
        const headers = new Headers();

        for (const [key, value] of Object.entries(request.headers)) {
          if (value !== undefined) {
            headers.append(key, String(value));
          }
        }

        const req = new Request(url.toString(), {
          method: request.method,
          headers,
          body:
            request.body && request.method !== 'GET'
              ? JSON.stringify(request.body)
              : undefined,
        });

        const response = await authInstance.handler(req);

        response.headers.forEach((value, key) => {
          reply.header(key, value);
        });

        reply.status(response.status);
        reply.send(response.body ? await response.text() : null);
      } catch (err) {
        fastify.log.error(err);
        reply.status(500).send({
          error: 'Internal authentication error',
          code: 'AUTH_FAILURE',
        });
      }
    },
  });
};

export default AuthRoutes;
