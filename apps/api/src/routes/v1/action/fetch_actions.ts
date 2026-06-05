import z, {
  FetchOwnedActionsQuerySchema,
  OwnedItemActionSchema,
} from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  collectOwnedActions,
  type OwnedActionsFilters,
} from '@/routes/v1/action/_owned_actions';

type FetchOwnedActionsRequest = FastifyRequest<{
  Querystring: z.infer<typeof FetchOwnedActionsQuerySchema>;
}>;

const FetchOwnedActionsResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  actions: OwnedItemActionSchema.array(),
});

export const fetch_actions: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/fetch',
    method: 'GET',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      query: FetchOwnedActionsQuerySchema,
      response: {
        200: FetchOwnedActionsResponseSchema,
      },
    },
    handler: fetch_actions_handler,
  });
};

const fetch_actions_handler = async (
  request: FetchOwnedActionsRequest,
  reply: FastifyReply
) => {
  const userId = request.user?.id;

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to fetch actions',
    });
  }

  const { limit, offset, ...rest } = request.query;
  const filters: OwnedActionsFilters = {
    action_id: rest.action_id,
    action_type: rest.action_type,
    action_status: rest.action_status,
    item_id: rest.item_id,
    ownership_role: rest.ownership_role,
  };

  try {
    // Local-only read. Cross-instance actions are mirrored to the initiator's
    // home instance at write time (target → source via
    // /api/v1/network/action/store_local), so every action the user owns — local
    // or recorded on a peer — already lives in this instance's item_actions.
    const { count, actions } = await collectOwnedActions({
      ownerId: userId,
      filters,
      limit,
      offset,
      log: request.log,
    });

    return reply.code(200).send({
      meta: { total: count, limit, offset },
      actions,
    });
  } catch (err) {
    request.log.error({ err, query: request.query }, 'Failed to fetch actions');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch actions',
    });
  }
};
