import z, {
  getActionInteraction,
  mergeItemStateWithPrivate,
  PerformActionBodySchema,
  projectPrivateStateForSchema,
  validateAgainstJsonSchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig, getCurrentApiBaseUrl } from '@/config';
import {
  buildNetworkActionTargetItem,
  fetchLocalItemSnapshot,
  normalizeInstanceUrl,
} from '@/utils/action_event_runtime';
import { db } from '@api/db/postgres/drizzle_config';
import { getNetworkConfigByName } from '@/network_configs';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';

type PerformActionRequest = FastifyRequest<{
  Body: z.infer<typeof PerformActionBodySchema>;
}>;

const PerformActionResponseSchema = z.object({
  action_id: z.string(),
  action_name: z.string(),
  action_status: z.string(),
  update_count: z.number().int().nonnegative(),
  source_item_id: z.string(),
  target_item_id: z.string(),
});

export const perform_action: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/perform',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: PerformActionBodySchema,
      response: {
        201: PerformActionResponseSchema,
      },
    },
    handler: perform_action_handler,
  });
};

export const perform_action_handler = async (
  request: PerformActionRequest,
  reply: FastifyReply
) => {
  const body = request.body;
  const sourceInstanceUrl = getCurrentApiBaseUrl();

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

  const sourceItem = {
    ...body.source_item,
    item_instance_url: sourceInstanceUrl,
  };
  const targetItem = buildNetworkActionTargetItem(body.target_item);

  const sourceItemSnapshot = await fetchLocalItemSnapshot(db, sourceItem);
  if (!sourceItemSnapshot) {
    return reply.code(404).send({
      error: 'SOURCE_ITEM_NOT_FOUND',
      message: 'Source item does not exist on this instance',
    });
  }

  let requirementsSnapshot = body.requirements_snapshot;

  try {
    const networkConfig = await getNetworkConfigByName(targetItem.item_network);
    const matchedDomain = networkConfig.domains.find(
      (domain) => domain.name === targetItem.item_domain
    );

    if (!matchedDomain) {
      return reply.code(400).send({
        error: 'INVALID_TARGET_ITEM',
        message: `Domain "${targetItem.item_domain}" is not defined for network "${targetItem.item_network}".`,
      });
    }

    const allowedInstance = networkConfig.instances.some(
      (instance) =>
        instance.domain_name === targetItem.item_domain &&
        normalizeInstanceUrl(instance.instance_url) ===
          normalizeInstanceUrl(targetItem.item_instance_url)
    );

    if (!allowedInstance) {
      return reply.code(400).send({
        error: 'INVALID_TARGET_INSTANCE',
        message: 'Target item instance URL is not allowed for this network/domain',
      });
    }

    const interaction = getActionInteraction(networkConfig, {
      actionName: body.action_name,
      fromNetwork: sourceItem.item_network,
      fromDomain: sourceItem.item_domain,
      fromItemType: sourceItem.item_type,
      toNetwork: targetItem.item_network,
      toDomain: targetItem.item_domain,
      toItemType: targetItem.item_type,
    });

    requirementsSnapshot = mergeItemStateWithPrivate(
      body.requirements_snapshot,
      projectPrivateStateForSchema(
        interaction.requirement_schema,
        sourceItemSnapshot.item_private_state
      )
    );

    validateAgainstJsonSchema(
      interaction.requirement_schema,
      requirementsSnapshot,
      'action requirements',
      { allowAdditionalProperties: apiConfig.allow_extra_schema_data }
    );
  } catch (err) {
    request.log.error(
      {
        err,
        action_name: body.action_name,
        target_item_id: body.target_item.item_id,
        target_instance_url: body.target_item.item_instance_url,
      },
      'Failed to validate action request'
    );

    return reply.code(400).send({
      error: 'INVALID_ACTION_REQUEST',
      message:
        err instanceof Error ? err.message : 'Invalid action request',
    });
  }

  try {
    const response = await fetch(
      new URL('/api/v1/network/action/perform', targetItem.item_instance_url),
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action_name: body.action_name,
          source_item: sourceItem,
          target_item: targetItem,
          source_item_owner: sourceItemSnapshot.created_by,
          requirements_snapshot: requirementsSnapshot,
        }),
      }
    );

    const responseBody = (await response.json()) as Record<string, unknown>;

    if (!response.ok) {
      return reply.code(response.status).send(responseBody);
    }

    return reply.code(201).send(responseBody);
  } catch (err) {
    request.log.error(
      {
        err,
        action_name: body.action_name,
        target_instance_url: targetItem.item_instance_url,
      },
      'Failed to call target instance perform action API'
    );

    return reply.code(502).send({
      error: 'TARGET_INSTANCE_UNAVAILABLE',
      message: 'Failed to reach the target instance perform action API',
    });
  }
};
