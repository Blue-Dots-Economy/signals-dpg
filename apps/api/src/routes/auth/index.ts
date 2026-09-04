import { authInstance } from '@/routes/auth/create_auth';
import { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

const AuthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    method: ['GET', 'POST', 'OPTIONS'],
    schema: { hide: true },
    url: '/api/auth/*',
    // No `config.rateLimit` here. There used to be
    // `{ rateLimit: { max: 10, timeWindow: '10 seconds' } }`, which did NOTHING:
    // @fastify/rate-limit is not a dependency of apps/api and is registered
    // nowhere, and Fastify silently ignores unknown `config` keys — so the line
    // read as protection while allowing unlimited traffic. Removed rather than
    // made real, because this path is rate-limited at the ingress instead:
    // `/api/auth` is an apiRateLimit group in the signals api chart (its own Kong
    // route and per-IP counter), and /api/auth/unified-otp/request carries a much
    // tighter otpRateLimit on top. Kong keys on the PROXY-protocol IP, which a
    // client cannot forge, and counts in shared Redis so the limit holds across
    // proxy replicas — neither of which an in-process limiter reading request.ip
    // can match. Do not reintroduce an app-level limiter here without first
    // installing and registering the plugin.

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
