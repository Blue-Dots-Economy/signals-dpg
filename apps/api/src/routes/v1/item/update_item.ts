import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  ItemResponseSchema,
  UpdateItemBodySchema,
  UpdateItemParamsSchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { updateItemInternal, ItemServiceError } from '@/services/item_service';
import { decryptItemPrivate } from '@/utils/item_decrypt';

type UpdateItemRequest = FastifyRequest<{
  Params: z.infer<typeof UpdateItemParamsSchema>;
  Body: z.infer<typeof UpdateItemBodySchema>;
}>;

export const update_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    method: 'PATCH',
    url: '/:itemId',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      params: UpdateItemParamsSchema,
      body: UpdateItemBodySchema,
      response: {
        200: z.object({
          item: ItemResponseSchema,
        }),
      },
    },
    handler: update_item_handler,
  });
};

export const update_item_handler = async (
  request: UpdateItemRequest,
  reply: FastifyReply
) => {
  const { itemId } = request.params;
  const body = request.body;
  const callerId = request.user?.id;
  const isAdmin = request.user?.role === 'admin';

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to update an item',
    });
  }

  try {
    const updated = await updateItemInternal(db, itemId, callerId, isAdmin, {
      item_state: body.item_state,
      item_latitude: body.item_latitude,
      item_longitude: body.item_longitude,
    });

    await invalidateItemFetchCache(updated.item_network, updated.item_domain).catch(
      (err) => request.log.warn({ err }, 'cache invalidation after update failed'),
    );

    // Surface real (decrypted) private values to the owner.
    const { mergedState } = decryptItemPrivate({
      item_state: updated.item_state as Record<string, unknown>,
      item_private_state: updated.item_private_state,
    });
    const { item_private_state: _drop, ...rest } = updated;

    return reply.code(200).send({
      item: { ...rest, item_state: mergedState },
    });
  } catch (err) {
    if (err instanceof ItemServiceError) {
      return reply.code(err.statusCode).send({
        error: err.errorCode,
        message: err.message,
      });
    }
    if (err instanceof DrizzleQueryError) {
      const cause = err.cause;
      if (cause instanceof DatabaseError && cause.code === '22P02') {
        return reply.code(400).send({
          error: 'INVALID_INPUT',
          message: 'Invalid value provided',
        });
      }
    }
    request.log.error({ err, itemId }, 'Failed to update item');
    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update item',
    });
  }
};
