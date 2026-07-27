import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { U18DobBodySchema, U18DobResponseSchema, type U18DobBody } from '@dpg/schemas';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import { getWardAge, setWardAge } from '@/services/minor_guardian_repo';

type Req = FastifyRequest<{ Body: U18DobBody }>;

export const u18_dob: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/dob',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: { tags: ['consent'], body: U18DobBodySchema, response: { 200: U18DobResponseSchema } },
    handler: u18_dob_handler,
  });
};

export const u18_dob_handler = async (request: Req, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });

  const { network, age } = request.body;
  if (!apiConfig.served_domains.some((b) => b.network === network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${network}" is not served` });
  }

  // Age range is enforced by the schema (0..120); no further bounding here.

  // Don't let a stored age be rewritten — especially a minor→adult flip after a
  // guardian is attached (which would silently de-gate the account). Re-sending
  // the same age is a harmless idempotent no-op; a different age is rejected.
  const existing = await getWardAge(userId);
  if (existing !== null) {
    if (existing !== age) {
      return reply.code(409).send({ error: 'DOB_ALREADY_SET', message: 'Age is already recorded and cannot be changed' });
    }
    return reply.code(200).send({ isMinor: isMinor(existing) });
  }

  try {
    await setWardAge(userId, age);
  } catch (err) {
    request.log.error({ err }, 'Failed to persist U18 age');
    return reply.code(500).send({ error: 'DOB_WRITE_FAILED', message: 'Failed to record age' });
  }

  return reply.code(200).send({ isMinor: isMinor(age) });
};
