import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  U18StatusQuerySchema,
  U18StatusResponseSchema,
  type U18StatusQuery,
} from '@dpg/schemas';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { isMinor } from '@/services/minor';
import { getMinorGuardian, getWardAge } from '@/services/minor_guardian_repo';

type Req = FastifyRequest<{ Querystring: U18StatusQuery }>;

/**
 * GET /u18/status — read-only U18 status for the authenticated ward.
 *
 * Derives everything from the stored `user.age` (captured ONCE) plus
 * the `minor_guardian` guardian-verified flag. The UI reads this to decide
 * whether to run the guardian flow — and whether the age is already on file —
 * instead of re-asking at profile-creation / action time.
 * The server stays authoritative; the client never supplies age or minor status.
 */
export const u18_status: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/u18/status',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['consent'],
      querystring: U18StatusQuerySchema,
      response: { 200: U18StatusResponseSchema },
    },
    handler: u18_status_handler,
  });
};

export const u18_status_handler = async (request: Req, reply: FastifyReply) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Authenticated user is required' });
  }

  const { network } = request.query;
  if (!apiConfig.served_domains.some((b) => b.network === network)) {
    return reply.code(400).send({ error: 'UNKNOWN_NETWORK', message: `Network "${network}" is not served` });
  }

  const age = await getWardAge(userId);
  const mg = await getMinorGuardian(userId);
  return reply.code(200).send({
    hasBirthData: age !== null,
    isMinor: age !== null && isMinor(age),
    guardianVerified: mg?.guardianVerified ?? false,
  });
};
