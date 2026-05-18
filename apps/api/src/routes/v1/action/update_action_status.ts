import { eq } from 'drizzle-orm';
import z, {
  getActionInteraction,
  UpdateActionStatusBodySchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  ensureActionEventPartition,
  item_actions,
} from '@dpg/database';
import { getCurrentApiBaseUrl } from '@/config';
import { getNetworkConfigByName } from '@/network_configs';
import {
  buildActionEventPayload,
  fetchLocalItemSnapshot,
  insertActionEvent,
  mirrorActionEventToSourceInstance,
  validateActionEventPayload,
} from '@/utils/action_event_runtime';

type UpdateActionStatusRequest = FastifyRequest<{
  Body: z.infer<typeof UpdateActionStatusBodySchema>;
}>;

const UpdateActionStatusResponseSchema = z.object({
  action_id: z.string(),
  action_name: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
});

export const update_action_status: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/update-status',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: UpdateActionStatusBodySchema,
      response: {
        200: UpdateActionStatusResponseSchema,
      },
    },
    handler: update_action_status_handler,
  });
};

export const update_action_status_handler = async (
  request: UpdateActionStatusRequest,
  reply: FastifyReply
) => {
  const body = request.body;
  const [existingAction] = await db
    .select()
    .from(item_actions)
    .where(eq(item_actions.action_id, body.action_id))
    .limit(1);

  if (!existingAction) {
    return reply.code(404).send({
      error: 'ACTION_NOT_FOUND',
      message: 'Action does not exist on this instance',
    });
  }

  let interaction: ReturnType<typeof getActionInteraction>;

  try {
    const networkConfig = await getNetworkConfigByName(existingAction.target_item_network);
    interaction = getActionInteraction(networkConfig, {
      actionName: existingAction.action_name,
      fromNetwork: existingAction.source_item_network,
      fromDomain: existingAction.source_item_domain,
      fromItemType: existingAction.source_item_type,
      toNetwork: existingAction.target_item_network,
      toDomain: existingAction.target_item_domain,
      toItemType: existingAction.target_item_type,
    });
  } catch (err) {
    return reply.code(400).send({
      error: 'INVALID_ACTION_EVENT',
      message: err instanceof Error ? err.message : 'Invalid action event',
    });
  }

  const eventPayload = buildActionEventPayload({
    event_schema: interaction.event_schema,
    action_status: body.action_status,
    remarks: body.remarks,
    context: {
      action_name: existingAction.action_name,
      source_item: {
        item_network: existingAction.source_item_network,
        item_domain: existingAction.source_item_domain,
        item_type: existingAction.source_item_type,
        item_id: existingAction.source_item_id,
        item_instance_url: existingAction.source_item_instance_url,
      },
      target_item: {
        item_network: existingAction.target_item_network,
        item_domain: existingAction.target_item_domain,
        item_type: existingAction.target_item_type,
        item_id: existingAction.target_item_id,
        item_instance_url: existingAction.target_item_instance_url,
      },
      requirements_snapshot: existingAction.requirements_snapshot as Record<
        string,
        unknown
      >,
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

  try {
    await ensureActionEventPartition(
      db,
      existingAction.target_item_network,
      existingAction.action_name
    );
  } catch (err) {
    request.log.error(
      {
        err,
        action_id: existingAction.action_id,
        action_name: existingAction.action_name,
      },
      'Failed to ensure action event partition'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for action event',
    });
  }

  const nextUpdateCount = existingAction.update_count + 1;
  const [updatedAction] = await db
    .update(item_actions)
    .set({
      action_status: body.action_status,
      update_count: nextUpdateCount,
      remarks: body.remarks ?? existingAction.remarks,
      updated_at: new Date(),
    })
    .where(eq(item_actions.action_id, existingAction.action_id))
    .returning({
      action_id: item_actions.action_id,
      action_name: item_actions.action_name,
      action_status: item_actions.action_status,
      update_count: item_actions.update_count,
      source_item_network: item_actions.source_item_network,
      source_item_domain: item_actions.source_item_domain,
      source_item_type: item_actions.source_item_type,
      source_item_id: item_actions.source_item_id,
      source_item_instance_url: item_actions.source_item_instance_url,
      source_item_owner: item_actions.source_item_owner,
      target_item_network: item_actions.target_item_network,
      target_item_domain: item_actions.target_item_domain,
      target_item_type: item_actions.target_item_type,
      target_item_id: item_actions.target_item_id,
      target_item_instance_url: item_actions.target_item_instance_url,
      target_item_owner: item_actions.target_item_owner,
      remarks: item_actions.remarks,
    });

  const targetItemSnapshot = await fetchLocalItemSnapshot(db, {
    item_network: updatedAction.target_item_network,
    item_domain: updatedAction.target_item_domain,
    item_type: updatedAction.target_item_type,
    item_id: updatedAction.target_item_id,
    item_instance_url: updatedAction.target_item_instance_url,
  });
  const sourceItemSnapshot =
    updatedAction.source_item_instance_url === getCurrentApiBaseUrl()
      ? await fetchLocalItemSnapshot(db, {
          item_network: updatedAction.source_item_network,
          item_domain: updatedAction.source_item_domain,
          item_type: updatedAction.source_item_type,
          item_id: updatedAction.source_item_id,
          item_instance_url: updatedAction.source_item_instance_url,
        })
      : null;

  const storedEvent = {
    origin_instance_domain: getCurrentApiBaseUrl(),
    action_name: updatedAction.action_name,
    action_id: updatedAction.action_id,
    action_status: updatedAction.action_status,
    update_count: updatedAction.update_count,
    source_item: {
      item_network: updatedAction.source_item_network,
      item_domain: updatedAction.source_item_domain,
      item_type: updatedAction.source_item_type,
      item_id: updatedAction.source_item_id,
      item_instance_url: updatedAction.source_item_instance_url,
    },
    target_item: {
      item_network: updatedAction.target_item_network,
      item_domain: updatedAction.target_item_domain,
      item_type: updatedAction.target_item_type,
      item_id: updatedAction.target_item_id,
      item_instance_url: updatedAction.target_item_instance_url,
    },
    source_item_owner:
      updatedAction.source_item_owner ?? sourceItemSnapshot?.created_by ?? null,
    target_item_owner:
      updatedAction.target_item_owner ?? targetItemSnapshot?.created_by ?? null,
    source_item_latitude: sourceItemSnapshot?.item_latitude ?? null,
    source_item_longitude: sourceItemSnapshot?.item_longitude ?? null,
    target_item_latitude: targetItemSnapshot?.item_latitude ?? null,
    target_item_longitude: targetItemSnapshot?.item_longitude ?? null,
    event_payload: eventPayload,
    remarks: body.remarks,
  };

  await insertActionEvent(db, storedEvent);
  void mirrorActionEventToSourceInstance(storedEvent, request.log);

  return reply.code(200).send({
    action_id: updatedAction.action_id,
    action_name: updatedAction.action_name,
    action_status: updatedAction.action_status,
    update_count: updatedAction.update_count,
  });
};
