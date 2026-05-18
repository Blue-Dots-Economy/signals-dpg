import z, {
  getActionInteraction,
  PerformNetworkActionBodySchema,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import {
  ensureActionEventPartition,
  ensureActionPartition,
  item_actions,
} from '@dpg/database';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import {
  buildActionEventPayload,
  fetchLocalItemSnapshot,
  insertActionEvent,
  isCurrentInstanceItem,
  mirrorActionEventToSourceInstance,
  validateActionEventPayload,
} from '@/utils/action_event_runtime';

type PerformNetworkActionRequest = FastifyRequest<{
  Body: z.infer<typeof PerformNetworkActionBodySchema>;
}>;

const PerformNetworkActionResponseSchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
  source_item_id: z.string(),
  target_item_id: z.string(),
});

export const perform_network_action: FastifyPluginAsyncZod = async function (
  fastify
) {
  fastify.route({
    url: '/action/perform',
    method: 'POST',
    schema: {
      tags: ['network'],
      body: PerformNetworkActionBodySchema,
      response: {
        201: PerformNetworkActionResponseSchema,
      },
    },
    handler: perform_network_action_handler,
  });
};

export const perform_network_action_handler = async (
  request: PerformNetworkActionRequest,
  reply: FastifyReply
) => {
  const body = request.body;

  if (
    !isServedDomainBinding(
      body.target_item.item_network,
      body.target_item.item_domain
    )
  ) {
    return await replyForUnservedDomain(
      reply,
      body.target_item.item_network,
      body.target_item.item_domain
    );
  }

  if (!isCurrentInstanceItem(body.target_item)) {
    return reply.code(400).send({
      error: 'INVALID_TARGET_INSTANCE',
      message: 'Actions must be created on the target item instance',
    });
  }

  let interaction: ReturnType<typeof getActionInteraction>;
  try {
    const networkConfig = await getNetworkConfigById(
      body.target_item.item_network
    );
    interaction = getActionInteraction(networkConfig, {
      actionType: body.action_type,
      fromNetwork: body.source_item.item_network,
      fromDomain: body.source_item.item_domain,
      fromItemType: body.source_item.item_type,
      toNetwork: body.target_item.item_network,
      toDomain: body.target_item.item_domain,
      toItemType: body.target_item.item_type,
    });

    validateAgainstJsonSchema(
      interaction.requirement_schema,
      body.requirements_snapshot,
      'action requirements',
      { allowAdditionalProperties: apiConfig.allow_extra_schema_data }
    );
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ACTION_REQUEST',
      message: err instanceof Error ? err.message : 'Invalid action request',
    });
  }

  const targetItemSnapshot = await fetchLocalItemSnapshot(db, body.target_item);
  if (!targetItemSnapshot) {
    return reply.code(404).send({
      error: 'TARGET_ITEM_NOT_FOUND',
      message: 'Target item does not exist on this instance',
    });
  }

  let sourceItemSnapshot = null;
  if (isCurrentInstanceItem(body.source_item)) {
    sourceItemSnapshot = await fetchLocalItemSnapshot(db, body.source_item);

    if (!sourceItemSnapshot) {
      return reply.code(404).send({
        error: 'SOURCE_ITEM_NOT_FOUND',
        message: 'Source item does not exist on this instance',
      });
    }
  }

  try {
    await ensureActionPartition(
      db,
      body.target_item.item_network,
      body.action_type
    );
    await ensureActionEventPartition(
      db,
      body.target_item.item_network,
      body.action_type
    );
  } catch (err) {
    request.log.error(
      {
        err,
        action_type: body.action_type,
      },
      'Failed to ensure action/event partitions'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for action or event type',
    });
  }

  const actionStatus = 'created';
  const updateCount = 0;
  const eventPayload = buildActionEventPayload({
    event_schema: interaction.event_schema,
    action_status: actionStatus,
    context: {
      action_type: body.action_type,
      source_item: body.source_item,
      target_item: body.target_item,
      requirements_snapshot: body.requirements_snapshot,
    },
  });

  try {
    validateActionEventPayload(interaction.event_schema, eventPayload);
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ACTION_EVENT',
      message: err instanceof Error ? err.message : 'Invalid action event',
    });
  }

  const [created] = await db
    .insert(item_actions)
    .values({
      action_type: body.action_type,
      partition_network: body.target_item.item_network,
      action_status: actionStatus,
      update_count: updateCount,
      source_item_network: body.source_item.item_network,
      source_item_domain: body.source_item.item_domain,
      source_item_type: body.source_item.item_type,
      source_item_id: body.source_item.item_id,
      source_item_instance_url: body.source_item.item_instance_url,
      source_item_owner: body.source_item_owner,
      target_item_network: body.target_item.item_network,
      target_item_domain: body.target_item.item_domain,
      target_item_type: body.target_item.item_type,
      target_item_id: body.target_item.item_id,
      target_item_instance_url: body.target_item.item_instance_url,
      target_item_owner: targetItemSnapshot.created_by,
      requirements_snapshot: body.requirements_snapshot,
      remarks: null,
    })
    .returning({
      action_id: item_actions.action_id,
      action_type: item_actions.action_type,
      action_status: item_actions.action_status,
      update_count: item_actions.update_count,
      source_item_id: item_actions.source_item_id,
      target_item_id: item_actions.target_item_id,
    });

  const storedEvent = {
    origin_instance_domain: getCurrentApiBaseUrl(),
    action_type: created.action_type,
    action_id: created.action_id,
    action_status: created.action_status,
    update_count: created.update_count,
    source_item: body.source_item,
    target_item: body.target_item,
    source_item_owner: body.source_item_owner,
    target_item_owner: targetItemSnapshot.created_by,
    source_item_latitude: sourceItemSnapshot?.item_latitude ?? null,
    source_item_longitude: sourceItemSnapshot?.item_longitude ?? null,
    target_item_latitude: targetItemSnapshot.item_latitude ?? null,
    target_item_longitude: targetItemSnapshot.item_longitude ?? null,
    event_payload: eventPayload,
  };

  await insertActionEvent(db, storedEvent);
  void mirrorActionEventToSourceInstance(storedEvent, request.log);

  return reply.code(201).send(created);
};
