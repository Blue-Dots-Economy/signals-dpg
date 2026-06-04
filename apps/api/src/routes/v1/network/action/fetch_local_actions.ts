import z, { OwnedItemActionSchema } from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { collectOwnedActions } from '@/routes/v1/action/_owned_actions';

/**
 * Public, server-to-server endpoint. A peer instance calls this to fetch the
 * actions owned by a given network-wide user id stored on THIS instance.
 *
 * It is the action-side analogue of /api/v1/network/item/fetch_local: the
 * authenticated /api/v1/action/fetch handler on the caller's home instance
 * fans out here so a user sees actions whose rows live on a different instance
 * (e.g. a Karnataka seeker's connect that was recorded on Maharashtra because
 * the provider lives there).
 *
 * No auth: the caller identity is the owner id in the body, trusted the same
 * way item fetch_local / count_local trust peer instances.
 */
const FetchLocalActionsBodySchema = z.object({
  owner_id: z.string().min(1),
  action_id: z.string().optional(),
  action_type: z.string().optional(),
  action_status: z.string().optional(),
  item_id: z.string().optional(),
  ownership_role: z.enum(['all', 'initiated', 'received']).default('all'),
  limit: z.number().int().min(1).max(100).default(100),
  offset: z.number().int().min(0).default(0),
});

const FetchLocalActionsResponseSchema = z.object({
  meta: z.object({
    total: z.number(),
    limit: z.number(),
    offset: z.number(),
  }),
  actions: OwnedItemActionSchema.array(),
});

type FetchLocalActionsRequest = FastifyRequest<{
  Body: z.infer<typeof FetchLocalActionsBodySchema>;
}>;

export const fetch_local_actions: FastifyPluginAsyncZod = async function (
  fastify
) {
  fastify.route({
    url: '/action/fetch_local',
    method: 'POST',
    schema: {
      tags: ['network'],
      body: FetchLocalActionsBodySchema,
      response: {
        200: FetchLocalActionsResponseSchema,
      },
    },
    handler: fetch_local_actions_handler,
  });
};

const fetch_local_actions_handler = async (
  request: FetchLocalActionsRequest,
  reply: FastifyReply
) => {
  const { owner_id, limit, offset, ...filters } = request.body;

  try {
    const { count, actions } = await collectOwnedActions({
      ownerId: owner_id,
      filters: {
        action_id: filters.action_id,
        action_type: filters.action_type,
        action_status: filters.action_status,
        item_id: filters.item_id,
        ownership_role: filters.ownership_role,
      },
      limit,
      offset,
      log: request.log,
    });

    return reply.code(200).send({
      meta: { total: count, limit, offset },
      actions,
    });
  } catch (err) {
    request.log.error(
      { err, body: request.body },
      'Failed to fetch local actions'
    );
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to fetch local actions',
    });
  }
};
