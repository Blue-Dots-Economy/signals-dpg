import z from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';

const SetDomainsBody = z.object({ domains: z.array(z.string().min(1)).min(1) });
const DomainsResponse = z.object({ domains: z.array(z.string()) });
type SetReq = FastifyRequest<{ Body: z.infer<typeof SetDomainsBody> }>;

/**
 * The domain roles the current user may create profiles in. Persisted at
 * signup (single now, an array for future multi-role). The profile form uses
 * these to narrow its domain picker — the SERVER does not (yet) treat this as
 * an authorization boundary (create_item enforces served-domain + the held-item
 * lock), so it's a UI convenience, not a gate. Null column → empty array.
 */
export const user_domains: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/domains',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], response: { 200: DomainsResponse } },
    handler: get_domains_handler,
  });

  fastify.route({
    url: '/domains',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['user'], body: SetDomainsBody, response: { 200: DomainsResponse } },
    handler: set_domains_handler,
  });
};

const get_domains_handler = async (request: FastifyRequest, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  const [row] = await db.select({ domains: user.domains }).from(user).where(eq(user.id, userId)).limit(1);
  return reply.code(200).send({ domains: row?.domains ?? [] });
};

const set_domains_handler = async (request: SetReq, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  // Only real served domains may be stored — reject arbitrary strings, which
  // would otherwise poison the profile-form picker (empty → creation lockout).
  const served = new Set(apiConfig.served_domains.map((b) => b.domain));
  const invalid = request.body.domains.filter((d) => !served.has(d));
  if (invalid.length > 0) {
    return reply.code(400).send({ error: 'UNSERVED_DOMAIN', message: `Not served: ${invalid.join(', ')}` });
  }

  // Union with existing so a second role adds, never clobbers.
  const [row] = await db.select({ domains: user.domains }).from(user).where(eq(user.id, userId)).limit(1);
  const merged = Array.from(new Set([...(row?.domains ?? []), ...request.body.domains]));
  await db.update(user).set({ domains: merged, updatedAt: new Date() }).where(eq(user.id, userId));
  return reply.code(200).send({ domains: merged });
};
