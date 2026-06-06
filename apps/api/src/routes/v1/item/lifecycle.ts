import { eq, sql } from 'drizzle-orm';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  ItemLifecycleBodySchema,
  ItemLifecycleResponseSchema,
  type ItemLifecycleBody as Body,
  mergeItemStateWithPrivate,
} from '@dpg/schemas';
import { items } from '@dpg/database';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { classify_item } from '@/services/items/classifier';
import { cancel_pending_actions_for_item } from '@/services/items/cancel_pending_actions';
import { getOrFetchSchemaByUrl } from '@/network_schema_cache';
import { decryptPiiBlob, getPiiKey } from '@dpg/auth';

type Req = FastifyRequest<{ Body: Body }>;

export const item_lifecycle: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/lifecycle',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: ItemLifecycleBodySchema,
      response: { 200: ItemLifecycleResponseSchema },
    },
    handler: item_lifecycle_handler,
  });
};

export const item_lifecycle_handler = async (
  request: Req,
  reply: FastifyReply,
) => {
  const callerId = request.user?.id;
  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  }
  const isNetworkService =
    request.acting_org?.org_type === 'network_service';

  const { item_id, action } = request.body;

  return await db.transaction(async (tx) => {
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
      return reply
        .code(404)
        .send({ error: 'ITEM_NOT_FOUND', message: 'Item does not exist' });
    }

    const isOwner = existing.created_by === callerId;
    if (!isOwner && !isNetworkService) {
      return reply.code(403).send({
        error: 'ITEM_NOT_OWNED_BY_USER',
        message:
          'Only the owner or a network_service acting org may change lifecycle',
      });
    }

    const current = existing.lifecycle_status as 'draft' | 'live' | 'paused';

    const schemaDoc = await getOrFetchSchemaByUrl({
      schemaUrl: existing.item_schema_url,
      network: existing.item_network,
      domain: existing.item_domain,
      itemType: existing.item_type,
    });
    const priorPrivate =
      existing.item_private_state === ''
        ? {}
        : (JSON.parse(
            decryptPiiBlob(existing.item_private_state ?? '', getPiiKey()),
          ) as Record<string, unknown>);
    const mergedState = mergeItemStateWithPrivate(
      existing.item_state as Record<string, unknown>,
      priorPrivate,
    );

    let next_status: 'draft' | 'live' | 'paused';
    let completion_pct: number;

    if (action === 'pause') {
      const c = classify_item({
        schema: schemaDoc as { required?: string[] },
        merged_state: mergedState,
        current_status: 'paused',
      });
      next_status = 'paused';
      completion_pct = c.completion_pct;
    } else {
      // unpause: recompute via classifier with non-paused baseline.
      const c = classify_item({
        schema: schemaDoc as { required?: string[] },
        merged_state: mergedState,
        current_status: 'draft',
      });
      next_status = c.lifecycle_status;
      completion_pct = c.completion_pct;
    }

    await tx
      .update(items)
      .set({
        lifecycle_status: next_status,
        completion_pct,
        updated_at: sql`now()`,
      })
      .where(eq(items.item_id, item_id));

    let cancelledPendingActions = 0;
    const isLeavingLive = current === 'live' && next_status !== 'live';
    if (isLeavingLive) {
      cancelledPendingActions = await cancel_pending_actions_for_item(
        tx,
        item_id,
      );
    }

    return reply.code(200).send({
      item_id,
      lifecycle_status: next_status,
      completion_pct,
      cancelled_pending_actions: cancelledPendingActions,
    });
  });
};

export default item_lifecycle;
