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
import { getNetworkConfigById } from '@/network_configs';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { eq } from 'drizzle-orm';
import { user } from '@api/db/postgres/schema/auth';
import { resolve_acting_actor } from './_resolve_acting_actor.js';

const action_error_messages = {
  CANNOT_OVERRIDE_SELF:
    'acting_as_user_id requires an x-acting-org-id header from a voice-type service apikey.',
  MISSING_ACTING_AS_USER_ID:
    'voice-type acting_org requires acting_as_user_id in the request body.',
  ACTING_ORG_TYPE_NOT_ALLOWED:
    'only voice-type acting orgs may act on behalf of users today.',
  NOT_AUTHORIZED_FOR_TARGET:
    'acting_as_user_id is not a user onboarded by this voice org.',
} as const;

type PerformActionRequest = FastifyRequest<{
  Body: z.infer<typeof PerformActionBodySchema>;
}>;

const PerformActionResponseSchema = z.object({
  action_id: z.string(),
  action_type: z.string(),
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

  const actor = await resolve_acting_actor({
    acting_org: request.acting_org,
    request_user_id: request.user.id,
    acting_as_user_id: body.acting_as_user_id,
    lookup_onboarded_by: async (user_id) => {
      const rows = await db
        .select({ onboardedByOrgId: user.onboardedByOrgId })
        .from(user)
        .where(eq(user.id, user_id))
        .limit(1);
      return rows[0]?.onboardedByOrgId ?? null;
    },
  });
  if (!actor.ok) {
    return reply.code(actor.status).send({
      error: actor.error,
      message: action_error_messages[actor.error],
    });
  }

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
  if (sourceItemSnapshot.created_by !== actor.effective_user_id) {
    return reply.code(403).send({
      error: 'SOURCE_ITEM_NOT_OWNED_BY_ACTOR',
      message:
        'source_item must be owned by the effective actor (request.user or acting_as_user_id)',
    });
  }

  let requirementsSnapshot = body.requirements_snapshot;

  try {
    const networkConfig = await getNetworkConfigById(targetItem.item_network);
    const matchedDomain = networkConfig.domains.find(
      (domain) => domain.id === targetItem.item_domain
    );

    if (!matchedDomain) {
      return reply.code(400).send({
        error: 'INVALID_TARGET_ITEM',
        message: `Domain "${targetItem.item_domain}" is not defined for network "${targetItem.item_network}".`,
      });
    }

    const allowedInstance = networkConfig.instances.some(
      (instance) =>
        instance.domain_id === targetItem.item_domain &&
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
      actionType: body.action_type,
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
        action_type: body.action_type,
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
          action_type: body.action_type,
          source_item: sourceItem,
          target_item: targetItem,
          source_item_owner: actor.effective_user_id,
          requirements_snapshot: requirementsSnapshot,
          performed_by_org_id: actor.audit.performed_by_org_id,
          performed_by_service_user_id: actor.audit.performed_by_service_user_id,
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
        action_type: body.action_type,
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
