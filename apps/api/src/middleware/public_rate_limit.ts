import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Per-IP fixed-window limiter for unauthenticated routes. Kong limits per route
 * in cluster deployments, but not every deployment has Kong, so this travels
 * with the app. Where both exist they stack; Kong's sees the real socket IP,
 * this one `trustProxy`'s reading of X-Forwarded-For.
 *
 * Fail-open: these are pre-login and federation paths, so a Redis outage
 * degrades to unlimited rather than locking everyone out. Never throws.
 *
 * @param name - Bucket name; also the log tag. Keep it route-shaped.
 * @param windowSec - Window length in seconds.
 */
export function public_rate_limit(
  name: string,
  maxPerWindow: number,
  windowSec = 60
) {
  return async function public_rate_limit_preHandler(
    request: FastifyRequest,
    reply: FastifyReply
  ) {
    try {
      // Lazy import: `utils/rate_window` opens a Redis connection on import,
      // which would force every route test using this guard to mock Redis.
      const { incrWithinWindow } = await import('@/utils/rate_window');
      const count = await incrWithinWindow(
        `public:rl:${name}:${request.ip}`,
        windowSec
      );
      if (count > maxPerWindow) {
        return reply.code(429).send({
          error: 'RATE_LIMITED',
          message: 'Too many requests; please try again later.',
        });
      }
    } catch (err) {
      request.log.warn(
        { err, limiter: name },
        'public rate-limit check unavailable; allowing request'
      );
    }
  };
}
