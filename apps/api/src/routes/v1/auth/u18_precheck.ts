import z from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { redis } from '@api/db/secondary/redis';
import { user } from '@api/db/postgres/schema';
import { items } from '@dpg/database';
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired } from '@/services/minor';

const U18PrecheckBody = z.object({
  network: z.string().min(1),
  email: z.string().email().optional(),
  phoneNumber: z.string().min(1).optional(),
});

// Reveal only the single boolean the login flow needs — NOT the domain — so an
// anonymous caller can't learn which gated domain an identifier participates in.
const U18PrecheckResponse = z.object({ requiresDob: z.boolean() });

// Per-IP fixed window to blunt identifier enumeration + the partition-wide scan
// on this public route.
const PRECHECK_WINDOW_SEC = 60;
const PRECHECK_MAX_PER_WINDOW = 20;

/**
 * PUBLIC, unauthenticated. Given a login identifier, tells the UI whether an
 * EXISTING user still needs to provide a date of birth before signing in (they
 * hold a profile in a guardian-gated domain and `user.age` is unset).
 * Returns only `requiresDob`. New users (no match) and users who already have an
 * age on file return `false`. Rate-limited per IP.
 */
export const u18_precheck: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/u18-precheck',
    method: 'POST',
    schema: {
      tags: ['auth'],
      body: U18PrecheckBody,
      response: { 200: U18PrecheckResponse },
    },
    handler: async (request, reply) => {
      // Rate limit per client IP (fixed window). Fail-safe: on a limiter error
      // we still answer — the endpoint is a hint, not a security control.
      try {
        const rlKey = `u18_precheck_rl:${request.ip}`;
        const n = await redis.incr(rlKey);
        if (n === 1) await redis.expire(rlKey, PRECHECK_WINDOW_SEC);
        if (n > PRECHECK_MAX_PER_WINDOW) {
          // Over the window → answer benignly (no enumeration signal).
          return reply.code(200).send({ requiresDob: false });
        }
      } catch {
        /* ignore limiter failure */
      }

      const body = request.body;
      const email = body.email?.trim().toLowerCase();
      const identifierCond = email
        ? eq(user.email, email)
        : body.phoneNumber
          ? eq(user.phoneNumber, body.phoneNumber.trim())
          : null;
      if (!identifierCond) return reply.code(200).send({ requiresDob: false });

      const [row] = await db
        .select({ id: user.id, age: user.age })
        .from(user)
        .where(identifierCond)
        .limit(1);

      if (!row || row.age !== null) return reply.code(200).send({ requiresDob: false });

      const owned = await db
        .selectDistinct({ domain: items.item_domain })
        .from(items)
        .where(and(eq(items.item_network, body.network), eq(items.created_by, row.id)));

      const networkConfig = await getNetworkConfigById(body.network).catch(() => null);
      if (!networkConfig) return reply.code(200).send({ requiresDob: false });

      const requiresDob = owned
        .map((o) => o.domain)
        .some((d) => guardianConsentRequired(networkConfig, d));

      return reply.code(200).send({ requiresDob });
    },
  });
};
