import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  CreateItemBodySchema,
  getDomainItemSchema,
  getDomainItemTypes,
  getInstanceCustomItemSchemaUrl,
  splitItemStateByPrivacy,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition, items } from '@dpg/database';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { getNetworkConfigById } from '@/network_configs';
import {
  buildNetworkItemSchemaUrl,
  getOrFetchSchemaByUrl,
} from '@/network_schema_cache';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';

type CreateItemRequest = FastifyRequest<{
  Body: z.infer<typeof CreateItemBodySchema>;
}>;

export const create_item: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/create',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: CreateItemBodySchema,
      response: {
        201: z.object({
          item_type: z.string(),
          item_id: z.string(),
        }),
      },
    },
    handler: create_item_handler,
  });
};

export const create_item_handler = async (
  request: CreateItemRequest,
  reply: FastifyReply
) => {
  const userId = request.user?.id;
  const body = request.body;
  const submittedItemState = body.item_state ?? {};
  const itemInstanceUrl = getCurrentApiBaseUrl();
  let itemSchemaUrl = `${itemInstanceUrl}/api/v1/network/schema/${encodeURIComponent(body.item_network)}/${encodeURIComponent(body.item_domain)}/${encodeURIComponent(body.item_type)}`;
  let itemState = {
    publicState: submittedItemState,
    privateState: {},
  };

  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to create an item',
    });
  }

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  try {
    const networkConfig = await getNetworkConfigById(body.item_network);
    const supportedItemTypes = getDomainItemTypes(
      networkConfig,
      body.item_domain
    );

    if (!supportedItemTypes.includes(body.item_type)) {
      throw new Error(
        `Item type "${body.item_type}" is not defined for domain "${body.item_domain}" in network "${body.item_network}".`
      );
    }

    let itemSchema: Record<string, unknown> | null = null;
    const expectedSchemaUrl = getInstanceCustomItemSchemaUrl(networkConfig, {
      domain: body.item_domain,
      instanceUrl: itemInstanceUrl,
      itemType: body.item_type,
    });

    if (expectedSchemaUrl) {
      itemSchemaUrl = expectedSchemaUrl;
      itemSchema = await getOrFetchSchemaByUrl({
        schemaUrl: expectedSchemaUrl,
        network: body.item_network,
        domain: body.item_domain,
        itemType: body.item_type,
        instanceUrl: itemInstanceUrl,
        kind: 'instance_custom_item_schema',
      });
    }

    if (!itemSchema) {
      itemSchema = getDomainItemSchema(
        networkConfig,
        body.item_domain,
        body.item_type
      );
      itemSchemaUrl =
        buildNetworkItemSchemaUrl({
          networkConfig,
          domain: body.item_domain,
          itemType: body.item_type,
        }) ?? itemSchemaUrl;
    }

    validateAgainstJsonSchema(itemSchema, submittedItemState, 'item_state', {
      allowAdditionalProperties: apiConfig.allow_extra_schema_data,
    });
    itemState = splitItemStateByPrivacy(itemSchema, submittedItemState);
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ITEM_STATE',
      message: err instanceof Error ? err.message : 'Invalid item_state',
    });
  }

  try {
    await ensureItemPartition(
      db,
      body.item_network,
      body.item_domain
    );
  } catch (err) {
    request.log.error(
      {
        err,
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
      },
      'Failed to ensure item partition'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for item type',
    });
  }

  try {
    const result = await db
      .insert(items)
      .values({
        item_network: body.item_network,
        item_type: body.item_type,

        item_domain: body.item_domain,
        item_instance_url: itemInstanceUrl,

        item_schema_url: itemSchemaUrl,

        item_state: itemState.publicState,
        item_private_state: itemState.privateState,
        item_latitude: body.item_latitude ?? null,
        item_longitude: body.item_longitude ?? null,
        created_by: userId,
      })
      .onConflictDoNothing({
        target: [
          items.item_network,
          items.item_domain,
          items.item_type,
          items.item_id,
        ],
      })
      .returning({
        itemNetwork: items.item_network,
        itemDomain: items.item_domain,
        itemType: items.item_type,
        itemId: items.item_id,
      });

    if (result.length === 0) {
      return reply.code(409).send({
        error: 'ITEM_ALREADY_EXISTS',
        message: 'An item with the same type and id already exists',
      });
    }

    return reply.code(201).send({
      item_type: result[0].itemType,
      item_id: result[0].itemId,
    });
  } catch (err) {
    /**
     * Handle known database errors explicitly
     */
    if (err instanceof DrizzleQueryError) {
      const cause = err.cause;

      if (cause instanceof DatabaseError) {
        // 23505 = unique_violation (fallback safety)
        if (cause.code === '23505') {
          return reply.code(409).send({
            error: 'ITEM_ALREADY_EXISTS',
            message: 'An item with the same type and id already exists',
          });
        }

        // 23503 = foreign_key_violation
        if (cause.code === '23503') {
          return reply.code(400).send({
            error: 'INVALID_REFERENCE',
            message:
              'One or more referenced entities do not exist, including the authenticated user',
          });
        }
      }
    }

    request.log.error(
      {
        err,
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
      },
      'Failed to create item'
    );

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to create item',
    });
  }
};
