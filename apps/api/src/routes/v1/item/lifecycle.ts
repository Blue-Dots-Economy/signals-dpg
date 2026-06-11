import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, { ItemLifecycleBody, ItemLifecycleResponse } from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler_optional } from '@/middleware/acting_org_optional';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { eq, sql } from 'drizzle-orm';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { getOrFetchSchemaByUrl } from '@/network_schema_cache';
import { classify_item } from '@/services/items/classifier';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';

type ItemLifecycleRequest = FastifyRequest<{
  Body: z.infer<typeof ItemLifecycleBody>;
}>;

export const item_lifecycle: FastifyPluginAsyncZod = async function (fastify) {
  // Order matters: auth_middleware_if_enabled populates `request.user` from the
  // apikey / session, which acting_org_preHandler_optional reads via
  // `request.user.id` to validate the service user. Both are registered as
  // plugin-level hooks so they fire before the route handler. Auth is
  // idempotent — the per-route preHandler below is a no-op second pass kept
  // for local readability.
  fastify.addHook('preHandler', auth_middleware_if_enabled);
  fastify.addHook('preHandler', acting_org_preHandler_optional);

  fastify.route({
    url: '/lifecycle',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: ItemLifecycleBody,
      response: {
        200: ItemLifecycleResponse,
      },
    },
    handler: item_lifecycle_handler,
  });
};

const item_lifecycle_handler = async (
  request: ItemLifecycleRequest,
  reply: FastifyReply,
) => {
  const callerId = request.user?.id;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  }

  const isNetworkService = request.acting_org?.org_type === 'network_service';
  const { item_id, action } = request.body;

  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select({
          item_id: items.item_id,
          item_network: items.item_network,
          item_domain: items.item_domain,
          item_type: items.item_type,
          item_schema_url: items.item_schema_url,
          item_state: items.item_state,
          item_private_state: items.item_private_state,
          lifecycle_status: items.lifecycle_status,
          created_by: items.created_by,
        })
        .from(items)
        .where(eq(items.item_id, item_id))
        .limit(1);

      if (!existing) {
        return { notFound: true } as const;
      }

      const isOwner = existing.created_by === callerId;
      if (!isOwner && !isNetworkService) {
        return { forbidden: true } as const;
      }

      const current = existing.lifecycle_status as 'draft' | 'live' | 'paused';

      if (action === 'unpause' && current !== 'paused') {
        return { invalidAction: true } as const;
      }

      const { mergedState } = decryptItemPrivate({
        item_state: existing.item_state as Record<string, unknown>,
        item_private_state: existing.item_private_state ?? '',
      });

      const itemSchema = await getOrFetchSchemaByUrl({
        schemaUrl: existing.item_schema_url,
        network: existing.item_network,
        domain: existing.item_domain,
        itemType: existing.item_type,
      });

      let next_status: 'draft' | 'live' | 'paused';

      if (action === 'pause') {
        next_status = 'paused';
      } else {
        // unpause: recompute draft/live from current data (non-sticky path).
        next_status = classify_item({
          schema: itemSchema as { required?: string[] },
          merged_state: mergedState,
          current_status: 'draft',
        }).lifecycle_status;
      }

      await tx
        .update(items)
        .set({
          lifecycle_status: next_status,
          updated_at: sql`now()`,
        })
        .where(eq(items.item_id, item_id));

      return {
        item_id,
        item_network: existing.item_network,
        item_domain: existing.item_domain,
        lifecycle_status: next_status,
      };
    });

    if ('notFound' in result) {
      return reply.code(404).send({
        error: 'ITEM_NOT_FOUND',
        message: 'Item not found',
      });
    }

    if ('forbidden' in result) {
      return reply.code(403).send({
        error: 'ITEM_NOT_OWNED_BY_USER',
        message: 'You do not own this item',
      });
    }

    if ('invalidAction' in result) {
      return reply.code(409).send({
        error: 'INVALID_LIFECYCLE_ACTION',
        message: 'unpause is only valid on a paused item',
      });
    }

    await invalidateItemFetchCache(result.item_network, result.item_domain).catch(
      (err) => request.log.warn({ err }, 'cache invalidation after lifecycle change failed'),
    );

    const { item_network: _n, item_domain: _d, ...responseBody } = result;
    return reply.code(200).send(responseBody);
  } catch (err) {
    request.log.error({ err, item_id, action }, 'Failed to update item lifecycle');

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update item lifecycle',
    });
  }
};
