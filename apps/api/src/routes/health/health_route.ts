import z from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { redis } from '@api/db/secondary/redis';

const LiveResponse = z.object({ status: z.literal('ok') });
const ReadyResponse = z.object({ status: z.literal('ready') });
const NotReadyResponse = z.object({
  status: z.literal('not_ready'),
  checks: z.object({ postgres: z.string(), redis: z.string() }),
});

/**
 * Runs a dependency check with a hard timeout, collapsing any failure
 * (rejection or timeout) to `'error'`. Keeps the readiness probe from hanging on
 * a wedged Postgres/Redis connection — satisfies the repo's external-call
 * timeout rule.
 *
 * @param fn - The dependency call to run (e.g. a `select 1` or a Redis `ping`).
 * @param ms - Timeout in milliseconds (default 2000).
 * @returns `'ok'` if it resolved in time, `'error'` otherwise.
 */
async function probe(fn: () => Promise<unknown>, ms = 2000): Promise<'ok' | 'error'> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      fn(),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
    return 'ok';
  } catch {
    return 'error';
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Liveness + readiness probes for the API.
 *
 * `GET /health/live` is a pure process-liveness signal (always 200 while the
 * event loop runs). `GET /health/ready` actively probes Postgres and Redis and
 * returns 503 (naming the failing dependency) when either is unreachable, so an
 * orchestrator does not route traffic to an instance that cannot serve it.
 */
const health_routes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    method: 'GET',
    url: '/health/live',
    schema: { tags: ['health'], response: { 200: LiveResponse } },
    handler: async () => ({ status: 'ok' as const }),
  });

  fastify.route({
    method: 'GET',
    url: '/health/ready',
    schema: { tags: ['health'], response: { 200: ReadyResponse, 503: NotReadyResponse } },
    handler: async (_request: FastifyRequest, reply: FastifyReply) => {
      const [postgres, redisStatus] = await Promise.all([
        probe(() => db.execute(sql`select 1`)),
        probe(() => redis.ping()),
      ]);
      if (postgres === 'ok' && redisStatus === 'ok') {
        return reply.code(200).send({ status: 'ready' as const });
      }
      return reply
        .code(503)
        .send({ status: 'not_ready' as const, checks: { postgres, redis: redisStatus } });
    },
  });
};

export default health_routes;
