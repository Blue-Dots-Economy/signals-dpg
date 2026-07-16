import z from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';

const SetDomainsBody = z.object({ domains: z.array(z.string().min(1)).min(1) });
const DomainsResponse = z.object({ domains: z.array(z.string()) });

/**
 * The domain roles the current user may create profiles in. Persisted at
 * signup (single now, an array for future multi-role: seeker AND provider) and
 * read by the profile form to restrict the domain picker. Null column →
 * empty array (callers then fall back to the user's held items).
 */
export const user_domains: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/domains',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], response: { 200: DomainsResponse } },
    handler: async (request, reply) => {
      const userId = request.user?.id;
      if (!userId) return reply.code(200).send({ domains: [] });
      const [row] = await db.select({ domains: user.domains }).from(user).where(eq(user.id, userId)).limit(1);
      return reply.code(200).send({ domains: row?.domains ?? [] });
    },
  });

  fastify.route({
    url: '/domains',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], body: SetDomainsBody, response: { 200: DomainsResponse } },
    handler: async (request, reply) => {
      const userId = request.user?.id;
      if (!userId) return reply.code(200).send({ domains: [] });
      // Union with existing so a second role adds, never clobbers.
      const [row] = await db.select({ domains: user.domains }).from(user).where(eq(user.id, userId)).limit(1);
      const merged = Array.from(new Set([...(row?.domains ?? []), ...request.body.domains]));
      await db.update(user).set({ domains: merged, updatedAt: new Date() }).where(eq(user.id, userId));
      return reply.code(200).send({ domains: merged });
    },
  });
};
