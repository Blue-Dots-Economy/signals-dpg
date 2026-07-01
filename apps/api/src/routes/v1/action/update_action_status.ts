import { and, eq } from 'drizzle-orm';
import z, {
  getActionInteraction,
  UpdateActionStatusBodySchema,
  BulkUpdateActionStatusResponseSchema,
  BulkRequestErrorSchema,
} from '@dpg/schemas';
import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  ensureActionEventPartition,
  item_actions,
} from '@dpg/database';
import { getCurrentApiBaseUrl, apiConfig } from '@/config';
import { getNetworkConfigById } from '@/network_configs';
import {
  buildActionEventPayload,
  fetchLocalItemSnapshot,
  insertActionEvent,
  isCurrentInstanceItem,
  mirrorActionEventToSourceInstance,
  validateActionEventPayload,
} from '@/utils/action_event_runtime';
import { runBulk, BulkItemFailure } from '@/utils/bulk_runner';
import { dispatchActionNotifications } from '@/notifications/notify_actions';

const BulkUpdateActionStatusBodySchema = z.array(z.unknown());

export const update_action_status: FastifyPluginAsyncZod = async function (fastify) {
  fastify.route({
    url: '/update-status',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['action'],
      body: BulkUpdateActionStatusBodySchema,
      response: {
        200: BulkUpdateActionStatusResponseSchema,
        207: BulkUpdateActionStatusResponseSchema,
        422: BulkUpdateActionStatusResponseSchema,
        400: BulkRequestErrorSchema,
      },
    },
    handler: update_action_status_handler,
  });
};

/**
 * Self-acted only. For receiver responses (accept/reject/…) the caller
 * (session cookie or apikey-as-self) must be the target item's owner. The one
 * exception is a cancellation (a status bucketed under metric_categories.cancel):
 * that is initiated by the source item owner to withdraw their own request, and
 * is only allowed while the receiver has not yet acted. On-behalf-of via
 * `acting_as_user_id` was removed by spec
 * 2026-05-23-action-on-behalf-of-network-service-tier-design.md — audit columns
 * on `item_actions` are populated only at create-time (by `/action/perform`).
 */
export const update_action_status_handler = async (
  request: FastifyRequest<{ Body: unknown[] }>,
  reply: FastifyReply,
) => {
  const callerId = request.user.id;

  const outcome = await runBulk(
    request.body,
    async (raw, index) => {
      const parsed = UpdateActionStatusBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw new BulkItemFailure(
          'INVALID_PAYLOAD',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
        );
      }
      const body = parsed.data;

      const [existingAction] = await db
        .select()
        .from(item_actions)
        .where(eq(item_actions.action_id, body.action_id))
        .limit(1);

      if (!existingAction) {
        throw new BulkItemFailure('ACTION_NOT_FOUND', 'Action does not exist on this instance');
      }

      let interaction: ReturnType<typeof getActionInteraction>;
      try {
        const networkConfig = await getNetworkConfigById(existingAction.target_item_network);
        interaction = getActionInteraction(networkConfig, {
          actionType: existingAction.action_type,
          fromNetwork: existingAction.source_item_network,
          fromDomain: existingAction.source_item_domain,
          fromItemType: existingAction.source_item_type,
          toNetwork: existingAction.target_item_network,
          toDomain: existingAction.target_item_domain,
          toItemType: existingAction.target_item_type,
        });
      } catch (err) {
        throw new BulkItemFailure(
          'INVALID_ACTION_EVENT',
          err instanceof Error ? err.message : 'Invalid action event',
        );
      }

      // Cancellation is terminal: once the source owner has withdrawn a
      // request, it is dead. No further transition (accept/reject or a repeat
      // cancel) is allowed by either party — otherwise the receiver could
      // "accept" an application the applicant already pulled.
      const cancelStatuses = interaction.metric_categories?.cancel ?? [];
      if (cancelStatuses.includes(existingAction.action_status)) {
        throw new BulkItemFailure(
          'ACTION_CANCELLED',
          'This request was cancelled and can no longer be updated.',
        );
      }

      // A "cancellation" is any status the network config buckets under
      // metric_categories.cancel. Every other transition is a receiver
      // response (self-acted by the target owner). A cancellation instead is
      // driven by the source item owner — the initiator withdrawing their own
      // request — and is only allowed while the receiver has not yet acted
      // (update_count === 0). Withdrawal is de-escalation, so it is not gated
      // on either side's liveness.
      const isCancellation = cancelStatuses.includes(body.action_status);

      if (isCancellation) {
        if (existingAction.source_item_owner !== callerId) {
          throw new BulkItemFailure(
            'NOT_SOURCE_ITEM_OWNER',
            'A request may only be cancelled by the source item owner.',
          );
        }
        if (existingAction.update_count > 0) {
          throw new BulkItemFailure(
            'RECEIVER_ALREADY_ACTED',
            'Cannot cancel; the receiver has already responded to this request.',
          );
        }
      } else {
        if (existingAction.target_item_owner !== callerId) {
          throw new BulkItemFailure(
            'NOT_TARGET_ITEM_OWNER',
            'update-status may only be called by the target item owner.',
          );
        }

        const targetSnapshot = await fetchLocalItemSnapshot(db, {
          item_network: existingAction.target_item_network,
          item_domain: existingAction.target_item_domain,
          item_type: existingAction.target_item_type,
          item_id: existingAction.target_item_id,
          item_instance_url: existingAction.target_item_instance_url,
        });
        if (!targetSnapshot || targetSnapshot.lifecycle_status !== 'live') {
          throw new BulkItemFailure(
            'PROFILE_NOT_LIVE',
            'target_item is not live; status updates blocked',
          );
        }

        if (
          isCurrentInstanceItem({
            item_network: existingAction.source_item_network,
            item_domain: existingAction.source_item_domain,
            item_type: existingAction.source_item_type,
            item_id: existingAction.source_item_id,
            item_instance_url: existingAction.source_item_instance_url,
          })
        ) {
          const sourceSnap = await fetchLocalItemSnapshot(db, {
            item_network: existingAction.source_item_network,
            item_domain: existingAction.source_item_domain,
            item_type: existingAction.source_item_type,
            item_id: existingAction.source_item_id,
            item_instance_url: existingAction.source_item_instance_url,
          });
          if (!sourceSnap || sourceSnap.lifecycle_status !== 'live') {
            throw new BulkItemFailure(
              'PROFILE_NOT_LIVE',
              'source_item is not live; status updates blocked',
            );
          }
        }
      }

      // Consent is a receiver-response gate. A cancellation is the source
      // owner withdrawing their own request — never a PII reveal — so it must
      // not be gated even if a network lists a cancel status in
      // reveals_pii_on_status.
      const requiresReceiverConsent =
        !isCancellation &&
        interaction.reveals_pii_on_status.includes(body.action_status) &&
        !!interaction.consent_text_receiver?.trim();

      if (requiresReceiverConsent && !body.consent?.acknowledged) {
        throw new BulkItemFailure(
          'CONSENT_REQUIRED',
          'Receiver consent acknowledgment required to transition to this status.',
        );
      }

      if (requiresReceiverConsent && body.consent?.acknowledged) {
        request.log.info(
          {
            side: 'receiver',
            action_id: body.action_id,
            action_status: body.action_status,
            consent_text_length: body.consent.text.length,
          },
          'consent recorded',
        );
      }

      const eventPayload = buildActionEventPayload({
        event_schema: interaction.event_schema,
        action_status: body.action_status,
        remarks: body.remarks,
        consent: body.consent,
        context: {
          action_type: existingAction.action_type,
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
          requirements_snapshot: existingAction.requirements_snapshot as Record<string, unknown>,
        },
      });

      try {
        validateActionEventPayload(interaction.event_schema, eventPayload);
      } catch (err) {
        throw new BulkItemFailure(
          'INVALID_ACTION_EVENT',
          err instanceof Error ? err.message : 'Invalid action event',
        );
      }

      try {
        await ensureActionEventPartition(
          db,
          existingAction.target_item_network,
          existingAction.action_type,
        );
      } catch (err) {
        request.log.error(
          { err, index, action_id: existingAction.action_id, action_type: existingAction.action_type },
          'Failed to ensure action event partition',
        );
        throw new BulkItemFailure('PARTITION_SETUP_FAILED', 'Failed to prepare storage for action event');
      }

      // Optimistic-concurrency guard: only write if update_count still matches
      // what we read. Cancellation adds a second legitimate writer (the source
      // owner alongside the target owner), so a concurrent cancel + accept must
      // not both land — the loser gets ACTION_CONFLICT instead of clobbering.
      const nextUpdateCount = existingAction.update_count + 1;
      const [updatedAction] = await db
        .update(item_actions)
        .set({
          action_status: body.action_status,
          update_count: nextUpdateCount,
          remarks: body.remarks ?? existingAction.remarks,
          updated_at: new Date(),
        })
        .where(
          and(
            eq(item_actions.action_id, existingAction.action_id),
            eq(item_actions.update_count, existingAction.update_count),
          ),
        )
        .returning({
          action_id: item_actions.action_id,
          action_type: item_actions.action_type,
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

      if (!updatedAction) {
        throw new BulkItemFailure(
          'ACTION_CONFLICT',
          'This request was updated by someone else; reload and try again.',
        );
      }

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
        action_type: updatedAction.action_type,
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
        source_item_owner: updatedAction.source_item_owner ?? sourceItemSnapshot?.created_by ?? null,
        target_item_owner: updatedAction.target_item_owner ?? targetItemSnapshot?.created_by ?? null,
        source_item_locations: sourceItemSnapshot?.item_locations ?? [],
        target_item_locations: targetItemSnapshot?.item_locations ?? [],
        event_payload: eventPayload,
        remarks: body.remarks,
      };

      const createdEvent = await insertActionEvent(db, storedEvent);
      void mirrorActionEventToSourceInstance(storedEvent, request.log);

      // Cancellation e-mails are deferred (separate issue): a source-initiated
      // withdrawal must not reuse the receiver-response copy, so we send no
      // notification for it here rather than send misleading mail.
      if (createdEvent && !isCancellation) {
        void dispatchActionNotifications(
          {
            lifecycle: 'status',
            actionType: updatedAction.action_type,
            actionId: updatedAction.action_id,
            status: updatedAction.action_status,
            updateCount: updatedAction.update_count,
            currentInstanceUrl: getCurrentApiBaseUrl(),
            source: {
              ownerUserId: storedEvent.source_item_owner,
              itemId: updatedAction.source_item_id,
              domain: updatedAction.source_item_domain,
              network: updatedAction.source_item_network,
              instanceUrl: updatedAction.source_item_instance_url,
            },
            target: {
              ownerUserId: storedEvent.target_item_owner,
              itemId: updatedAction.target_item_id,
              domain: updatedAction.target_item_domain,
              network: updatedAction.target_item_network,
              instanceUrl: updatedAction.target_item_instance_url,
            },
          },
          request.log,
        ).catch((err) =>
          request.log.error({ err }, 'action notification dispatch failed'),
        );
      }

      return {
        action_id: updatedAction.action_id,
        action_type: updatedAction.action_type,
        action_status: updatedAction.action_status,
        update_count: updatedAction.update_count,
      };
    },
    {
      okStatus: 200,
      maxItems: apiConfig.bulk_max_items,
      onUnexpectedError: (err, index) =>
        request.log.error({ err, index }, 'bulk update-status unexpected error'),
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
