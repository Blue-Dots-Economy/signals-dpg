import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  ItemResponseSchema,
  mergeItemStateWithPrivate,
  splitItemStateByPrivacy,
  UpdateItemBodySchema,
  UpdateItemParamsSchema,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { and, DrizzleQueryError, eq, sql } from 'drizzle-orm';
import { DatabaseError } from '@dpg/database';
import { items } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { getOrFetchSchemaByUrl } from '@/network_schema_cache';

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
  const userId = request.user?.id;

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to update an item',
    });
  }

  try {
    const updateValues: Record<string, unknown> = {
      ...body,
      updated_at: sql`now()`,
    };

    if (body.item_state) {
      const [existingItem] = await db
        .select({
          item_network: items.item_network,
          item_domain: items.item_domain,
          item_type: items.item_type,
          item_schema_url: items.item_schema_url,
        })
        .from(items)
        .where(and(eq(items.item_id, itemId), eq(items.created_by, userId)))
        .limit(1);

      if (!existingItem) {
        return reply.code(404).send({
          error: 'ITEM_NOT_FOUND_OR_FORBIDDEN',
          message: 'Item not found or does not belong to the authenticated user',
        });
      }

      const itemSchema = await getOrFetchSchemaByUrl({
        schemaUrl: existingItem.item_schema_url,
        network: existingItem.item_network,
        domain: existingItem.item_domain,
        itemType: existingItem.item_type,
      });

      validateAgainstJsonSchema(itemSchema, body.item_state, 'item_state', {
        allowAdditionalProperties: apiConfig.allow_extra_schema_data,
      });

      const splitState = splitItemStateByPrivacy(itemSchema, body.item_state);
      updateValues.item_state = splitState.publicState;
      updateValues.item_private_state = splitState.privateState;
    }

    const result = await db
      .update(items)
      .set(updateValues)
      .where(and(eq(items.item_id, itemId), eq(items.created_by, userId)))
      .returning({
        item_network: items.item_network,
        item_domain: items.item_domain,
        item_type: items.item_type,
        item_id: items.item_id,
        item_instance_url: items.item_instance_url,
        item_schema_url: items.item_schema_url,
        item_state: items.item_state,
        item_private_state: items.item_private_state,
        item_latitude: items.item_latitude,
        item_longitude: items.item_longitude,
        created_by: items.created_by,
        created_at: items.created_at,
        updated_at: items.updated_at,
      });

    if (result.length === 0) {
      return reply.code(404).send({
        error: 'ITEM_NOT_FOUND_OR_FORBIDDEN',
        message: 'Item not found or does not belong to the authenticated user',
      });
    }

    const { item_private_state, ...updatedItem } = result[0];

    return reply.code(200).send({
      item: {
        ...updatedItem,
        item_state: mergeItemStateWithPrivate(
          result[0].item_state,
          item_private_state
        ),
      },
    });
  } catch (err) {
    if (err instanceof DrizzleQueryError) {
      const cause = err.cause;

      if (cause instanceof DatabaseError) {
        // Example: JSON schema / type issues
        if (cause.code === '22P02') {
          return reply.code(400).send({
            error: 'INVALID_INPUT',
            message: 'Invalid value provided',
          });
        }
      }
    }

    request.log.error({ err, itemId }, 'Failed to update item');

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update item',
    });
  }
};
