import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, { UpdateItemParamsSchema } from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';

type DeleteItemRequest = FastifyRequest<{
  Params: z.infer<typeof UpdateItemParamsSchema>;
}>;

export const delete_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    method: 'DELETE',
    url: '/:itemId',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      params: UpdateItemParamsSchema,
      response: {
        204: z.null(),
      },
    },
    handler: delete_item_handler,
  });
};

/**
 * Owner-only hard delete. Caller must be the user that authored the item
 * (`items.created_by = session.user.id`); admins do not get a bypass here
 * — that's an aggregator-side concern, not part of the user-owned
 * profile management flow.
 *
 * Returns 204 No Content on success, 404 when the row does not exist or
 * belongs to another user (same envelope so the endpoint never leaks the
 * existence of someone else's row).
 */
export const delete_item_handler = async (
  request: DeleteItemRequest,
  reply: FastifyReply
) => {
  const { itemId } = request.params;
  const callerId = request.user?.id;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to delete an item',
    });
  }

  try {
    const result = await db
      .delete(items)
      .where(and(eq(items.item_id, itemId), eq(items.created_by, callerId)))
      .returning({
        item_id: items.item_id,
        item_network: items.item_network,
        item_domain: items.item_domain,
      });

    if (result.length === 0) {
      return reply.code(404).send({
        error: 'ITEM_NOT_FOUND_OR_FORBIDDEN',
        message: 'Item not found or does not belong to the authenticated user',
      });
    }

    // Cache invalidation: the inter-instance read path caches `item-count`
    // and `item-page` for up to `minimum_cache_ttl_seconds` (5 min by
    // default for blue_dot/seeker). Without this sweep the deleted row
    // keeps showing up on /network/item/fetch until the TTL expires.
    await invalidateItemFetchCache(result[0].item_network, result[0].item_domain).catch(
      (err) => request.log.warn({ err }, 'cache invalidation after delete failed'),
    );

    return reply.code(204).send();
  } catch (err) {
    request.log.error({ err, itemId }, 'Failed to delete item');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to delete item',
    });
  }
};
