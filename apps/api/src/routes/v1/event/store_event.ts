import { sql } from 'drizzle-orm';
import z, {
  getActionInteraction,
  StoreEventBodySchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  ensureActionEventPartition,
  ensureActionPartition,
  item_actions,
} from '@dpg/database';
import { getNetworkConfigById } from '@/network_configs';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import {
  insertActionEvent,
  validateActionEventPayload,
} from '@/utils/action_event_runtime';

type StoreEventRequest = FastifyRequest<{
  Body: z.infer<typeof StoreEventBodySchema>;
}>;

const StoreEventResponseSchema = z.object({
  event_id: z.string().nullable(),
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
});

export const store_event: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/store',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['event'],
      body: StoreEventBodySchema,
      response: {
        201: StoreEventResponseSchema,
      },
    },
    handler: store_event_handler,
  });
};

export const store_event_handler = async (
  request: StoreEventRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (
    !isServedDomainBinding(
      body.source_item.item_network,
      body.source_item.item_domain
    )
  ) {
    return await replyForUnservedDomain(
      reply,
      body.source_item.item_network,
      body.source_item.item_domain
    );
  }

  try {
    const networkConfig = await getNetworkConfigById(body.target_item.item_network);
    const interaction = getActionInteraction(networkConfig, {
      actionType: body.action_type,
      fromNetwork: body.source_item.item_network,
      fromDomain: body.source_item.item_domain,
      fromItemType: body.source_item.item_type,
      toNetwork: body.target_item.item_network,
      toDomain: body.target_item.item_domain,
      toItemType: body.target_item.item_type,
    });

    validateActionEventPayload(interaction.event_schema, body.event_payload);
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_EVENT_REQUEST',
      message: err instanceof Error ? err.message : 'Invalid event request',
    });
  }

  try {
    await ensureActionEventPartition(
      db,
      body.source_item.item_network,
      body.action_type
    );
  } catch (err) {
    request.log.error(
      {
        err,
        action_type: body.action_type,
        action_id: body.action_id,
      },
      'Failed to ensure event partition'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for event type',
    });
  }

  const created = await insertActionEvent(db, body);

  // Project the current item_actions row from the mirrored event. The event
  // mirror fires on create AND every status change, so this keeps the source
  // instance's item_actions row — which GET /api/v1/action/fetch reads — in
  // sync without a separate row-sync channel. Best-effort: a projection error
  // must not drop the stored event. Keyed on the action's PK; setWhere guards
  // against out-of-order delivery overwriting newer state.
  try {
    await ensureActionPartition(db, body.target_item.item_network, body.action_type);
    await db
      .insert(item_actions)
      .values({
        action_type: body.action_type,
        partition_network: body.target_item.item_network,
        action_id: body.action_id,
        action_status: body.action_status,
        update_count: body.update_count,
        source_item_network: body.source_item.item_network,
        source_item_domain: body.source_item.item_domain,
        source_item_type: body.source_item.item_type,
        source_item_id: body.source_item.item_id,
        source_item_instance_url: body.source_item.item_instance_url,
        source_item_owner: body.source_item_owner ?? null,
        target_item_network: body.target_item.item_network,
        target_item_domain: body.target_item.item_domain,
        target_item_type: body.target_item.item_type,
        target_item_id: body.target_item.item_id,
        target_item_instance_url: body.target_item.item_instance_url,
        target_item_owner: body.target_item_owner ?? null,
        remarks: body.remarks ?? null,
      })
      .onConflictDoUpdate({
        target: [
          item_actions.partition_network,
          item_actions.action_type,
          item_actions.action_id,
        ],
        set: {
          action_status: body.action_status,
          update_count: body.update_count,
          source_item_owner: body.source_item_owner ?? null,
          target_item_owner: body.target_item_owner ?? null,
          remarks: body.remarks ?? null,
          updated_at: new Date(),
        },
        setWhere: sql`${item_actions.update_count} <= ${body.update_count}`,
      });
  } catch (err) {
    request.log.error(
      { err, action_id: body.action_id, update_count: body.update_count },
      'Failed to project item_actions from mirrored event'
    );
  }

  return reply.code(201).send({
    event_id: created?.event_id ?? null,
    action_id: body.action_id,
    action_type: body.action_type,
    action_status: body.action_status,
    update_count: body.update_count,
  });
};
