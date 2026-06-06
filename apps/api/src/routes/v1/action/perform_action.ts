import z, {
  getActionInteraction,
  mergeItemStateWithPrivate,
  PerformActionBodySchema,
  projectPrivateStateForSchema,
  validateAgainstJsonSchema,
  BulkPerformActionResponseSchema,
  BulkRequestErrorSchema,
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
import { isServedDomainBinding } from '@/utils/served_domain_guard';
import {
  resolve_acting_actor,
  action_error_messages,
  lookup_user_for_acting,
} from './_resolve_acting_actor.js';
import { runBulk, BulkItemFailure } from '@/utils/bulk_runner';

const BulkPerformActionBodySchema = z.array(z.unknown());

export const perform_action: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/perform',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: BulkPerformActionBodySchema,
      response: {
        201: BulkPerformActionResponseSchema,
        207: BulkPerformActionResponseSchema,
        422: BulkPerformActionResponseSchema,
        400: BulkRequestErrorSchema,
      },
    },
    handler: perform_action_handler,
  });
};

export const perform_action_handler = async (
  request: FastifyRequest<{ Body: unknown[] }>,
  reply: FastifyReply,
) => {
  const sourceInstanceUrl = getCurrentApiBaseUrl();

  const outcome = await runBulk(
    request.body,
    async (raw, index) => {
      const parsed = PerformActionBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BulkItemFailure(
          'INVALID_PAYLOAD',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const body = parsed.data;

      const actor = await resolve_acting_actor({
        acting_org: request.acting_org,
        request_user_id: request.user.id,
        acting_as_user_id: body.acting_as_user_id,
        lookup_user: lookup_user_for_acting,
      });
      if (!actor.ok) {
        throw new BulkItemFailure(actor.error, action_error_messages[actor.error]);
      }

      if (!isServedDomainBinding(body.source_item.item_network, body.source_item.item_domain)) {
        throw new BulkItemFailure(
          'UNSERVED_DOMAIN_BINDING',
          `This API instance does not serve "${body.source_item.item_network}/${body.source_item.item_domain}".`,
        );
      }

      const sourceItem = { ...body.source_item, item_instance_url: sourceInstanceUrl };
      const targetItem = buildNetworkActionTargetItem(body.target_item);

      const sourceItemSnapshot = await fetchLocalItemSnapshot(db, sourceItem);
      if (!sourceItemSnapshot) {
        throw new BulkItemFailure('SOURCE_ITEM_NOT_FOUND', 'Source item does not exist on this instance');
      }
      if (sourceItemSnapshot.created_by !== actor.effective_user_id) {
        throw new BulkItemFailure(
          'SOURCE_ITEM_NOT_OWNED_BY_ACTOR',
          'source_item must be owned by the effective actor (request.user or acting_as_user_id)',
        );
      }
      if (sourceItemSnapshot.lifecycle_status !== 'live') {
        throw new BulkItemFailure(
          'PROFILE_NOT_LIVE',
          'source_item is not live; cannot perform actions',
        );
      }

      let requirementsSnapshot = body.requirements_snapshot;

      try {
        const networkConfig = await getNetworkConfigById(targetItem.item_network);
        const matchedDomain = networkConfig.domains.find(
          (domain) => domain.id === targetItem.item_domain,
        );

        if (!matchedDomain) {
          throw new BulkItemFailure(
            'INVALID_TARGET_ITEM',
            `Domain "${targetItem.item_domain}" is not defined for network "${targetItem.item_network}".`,
          );
        }

        const allowedInstance = networkConfig.instances.some(
          (instance) =>
            instance.domain_id === targetItem.item_domain &&
            normalizeInstanceUrl(instance.instance_url) ===
              normalizeInstanceUrl(targetItem.item_instance_url),
        );

        if (!allowedInstance) {
          throw new BulkItemFailure(
            'INVALID_TARGET_INSTANCE',
            'Target item instance URL is not allowed for this network/domain',
          );
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

        if (interaction.consent_text_initiator?.trim() && !body.consent?.acknowledged) {
          throw new BulkItemFailure('CONSENT_REQUIRED', 'Initiator consent acknowledgment required for this action.');
        }

        if (interaction.consent_text_initiator?.trim() && body.consent?.acknowledged) {
          request.log.info(
            {
              side: 'initiator',
              action_type: body.action_type,
              target_item_id: body.target_item.item_id,
              consent_text_length: body.consent.text.length,
            },
            'consent recorded',
          );
        }

        requirementsSnapshot = mergeItemStateWithPrivate(
          body.requirements_snapshot,
          projectPrivateStateForSchema(
            interaction.requirement_schema,
            sourceItemSnapshot.private_state,
          ),
        );

        validateAgainstJsonSchema(
          interaction.requirement_schema,
          requirementsSnapshot,
          'action requirements',
          { allowAdditionalProperties: apiConfig.allow_extra_schema_data },
        );
      } catch (err) {
        if (err instanceof BulkItemFailure) throw err;
        request.log.error(
          {
            err,
            index,
            action_type: body.action_type,
            target_item_id: body.target_item.item_id,
            target_instance_url: body.target_item.item_instance_url,
          },
          'Failed to validate action request',
        );
        throw new BulkItemFailure(
          'INVALID_ACTION_REQUEST',
          err instanceof Error ? err.message : 'Invalid action request',
        );
      }

      let responseOk: boolean;
      let responseBody: Record<string, unknown>;
      try {
        const response = await fetch(
          new URL('/api/v1/network/action/perform', targetItem.item_instance_url),
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              action_type: body.action_type,
              source_item: sourceItem,
              target_item: targetItem,
              source_item_owner: actor.effective_user_id,
              requirements_snapshot: requirementsSnapshot,
              performed_by_org_id: actor.audit.performed_by_org_id,
              performed_by_service_user_id: actor.audit.performed_by_service_user_id,
              consent: body.consent,
            }),
          },
        );
        responseOk = response.ok;
        responseBody = (await response.json()) as Record<string, unknown>;
      } catch (err) {
        request.log.error(
          {
            err,
            index,
            action_type: body.action_type,
            target_instance_url: targetItem.item_instance_url,
          },
          'Failed to call target instance perform action API',
        );
        throw new BulkItemFailure(
          'TARGET_INSTANCE_UNAVAILABLE',
          'Failed to reach the target instance perform action API',
        );
      }

      if (!responseOk) {
        const code = typeof responseBody.error === 'string' ? responseBody.error : 'TARGET_INSTANCE_ERROR';
        const message =
          typeof responseBody.message === 'string'
            ? responseBody.message
            : 'Target instance rejected the action';
        throw new BulkItemFailure(code, message);
      }

      return responseBody as {
        action_id: string;
        action_type: string;
        action_status: string;
        update_count: number;
        source_item_id: string;
        target_item_id: string;
      };
    },
    {
      okStatus: 201,
      maxItems: apiConfig.bulk_max_items,
      onUnexpectedError: (err, index) =>
        request.log.error({ err, index }, 'bulk perform action unexpected error'),
    },
  );

  if (outcome.requestError) {
    return reply.code(400).send({
      error: outcome.requestError.code,
      message: outcome.requestError.message,
    });
  }

  return reply.code(outcome.httpStatus!).send({
    results: outcome.results,
    summary: outcome.summary,
  });
};
