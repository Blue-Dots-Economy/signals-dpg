import type { FastifyRequest, FastifyReply } from 'fastify';
import { redis } from '@api/db/secondary/redis';

const WINDOW_SECONDS = 60;
const MAX_REQUESTS = 5;

/**
 * Fixed-window per-IP rate limit scoped to POST /network/refetch_schemas —
 * a single-route limiter rather than a global plugin, because this route
 * triggers an expensive schema-cache rebuild and is the only endpoint that
 * needs this granularity today. Fails open on Redis errors so a Redis
 * outage doesn't take down schema refetching entirely.
 */
export const refetch_schemas_rate_limit = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const key = `rl:refetch_schemas:${request.ip}`;
  try {
    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, WINDOW_SECONDS);
    }
    if (count > MAX_REQUESTS) {
      reply.header('Retry-After', String(WINDOW_SECONDS));
      return reply.code(429).send({
        error: 'RATE_LIMITED',
        message: 'Too many refetch requests, try again later',
      });
    }
  } catch (err) {
    request.log.error(
      { err, operation: 'refetch_schemas_rate_limit' },
      'Rate limiter check failed, allowing request (fail-open)',
    );
  }
};
