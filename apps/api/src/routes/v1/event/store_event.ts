import z, {
  getActionInteraction,
  StoreEventBodySchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { ensureActionEventPartition } from '@dpg/database';
import { getNetworkConfigByName } from '@/network_configs';
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
  action_name: z.string(),
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
    const networkConfig = await getNetworkConfigByName(body.target_item.item_network);
    const interaction = getActionInteraction(networkConfig, {
      actionName: body.action_name,
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
      body.action_name
    );
  } catch (err) {
    request.log.error(
      {
        err,
        action_name: body.action_name,
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

  return reply.code(201).send({
    event_id: created?.event_id ?? null,
    action_id: body.action_id,
    action_name: body.action_name,
    action_status: body.action_status,
    update_count: body.update_count,
  });
};
