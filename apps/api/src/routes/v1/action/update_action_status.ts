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
import { consent_record } from '@api/db/postgres/schema';
import { resolveConsentVersion } from '@/services/consent_version';
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
import {
  guardianActionGate,
  guardianBulkActionGate,
  guardianGateFailure,
  type BulkGateItem,
  type GateResult,
} from '@/services/guardian_action_gate';
import { guardianActionConsentRow, actionConsentRow } from '@/services/guardian_consent_rows';

const BulkUpdateActionStatusBodySchema = z.array(z.unknown());

/**
 * Thrown inside the status-update transaction when the accept-consent row
 * cannot be written, so the status update rolls back with it (fail-closed — the
 * PII-revealing accept is not applied without a consent record).
 */
class ConsentWriteError extends Error {}

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
 * Pre-pass for the bulk update-status route (accept side): gate every row whose
 * accept reveals the caller's PII (the same `requiresReceiverConsent` condition
 * as the main loop) with one guardian OTP + one email instead of one per row,
 * mirroring perform_action's initiator-side pre-pass. Other rows fall back to
 * the per-item gate. The OTP is read from the first row carrying
 * `guardian_otp`. As in the single call, the accepting minor's own item is the
 * gate scope's *source* and the counterparty's item its *target*.
 */
async function buildBulkGuardianAcceptGate(
  items: unknown[],
  callerId: string,
): Promise<Map<number, GateResult>> {
  const gateItems: BulkGateItem[] = [];
  let otp: string | undefined;
  for (let index = 0; index < items.length; index++) {
    const parsed = UpdateActionStatusBodySchema.safeParse(items[index]);
    if (!parsed.success) continue;
    const body = parsed.data;
    if (!otp && body.guardian_otp) otp = body.guardian_otp;

    const [existingAction] = await db
      .select()
      .from(item_actions)
      .where(eq(item_actions.action_id, body.action_id))
      .limit(1);
    if (!existingAction) continue;
    // Only the accepting party (target item owner) is gated here.
    if (existingAction.target_item_owner !== callerId) continue;

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
    } catch {
      continue; // the per-item handler surfaces the real INVALID_ACTION_EVENT
    }

    const cancelStatuses = interaction.metric_categories?.cancel ?? [];
    const isCancellation = cancelStatuses.includes(body.action_status);
    const requiresReceiverConsent =
      !isCancellation && interaction.reveals_pii_on_status.includes(body.action_status);
    if (!requiresReceiverConsent) continue;

    gateItems.push({
      index,
      wardUserId: callerId,
      network: existingAction.target_item_network,
      sourceDomain: existingAction.target_item_domain,
      actionType: existingAction.action_type,
      sourceItemId: existingAction.target_item_id,
      targetItemId: existingAction.source_item_id,
    });
  }
  if (gateItems.length === 0) return new Map();
  return guardianBulkActionGate({ items: gateItems, stage: 'accept', otp });
}

/**
 * Self-acted only: there is no on-behalf-of here, and the `item_actions` audit
 * columns are populated only at create time (by `/action/perform`). For
 * receiver responses (accept/reject/…) the caller must own the target item.
 * The exception is a cancellation (a status bucketed under
 * metric_categories.cancel): the source item owner withdrawing their own
 * request, allowed only while the receiver has not yet acted.
 */
export const update_action_status_handler = async (
  request: FastifyRequest<{ Body: unknown[] }>,
  reply: FastifyReply,
) => {
  const callerId = request.user.id;

  // Only a genuine batch (>1 row) within the bulk limit uses the one-OTP-per-
  // batch gate; an over-limit batch is left for runBulk to reject. If the
  // pre-pass errors, the per-item gate (still fail-closed) takes over.
  let batchGate: Map<number, GateResult> | undefined;
  if (request.body.length > 1 && request.body.length <= apiConfig.bulk_max_items) {
    try {
      batchGate = await buildBulkGuardianAcceptGate(request.body, callerId);
    } catch (err) {
      request.log.error(
        { err },
        'bulk guardian accept pre-pass failed; falling back to per-action gate',
      );
      batchGate = undefined;
    }
  }

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

      // Cancellation is terminal for both parties, so the receiver cannot
      // "accept" an application the applicant already withdrew.
      const cancelStatuses = interaction.metric_categories?.cancel ?? [];
      if (cancelStatuses.includes(existingAction.action_status)) {
        throw new BulkItemFailure(
          'ACTION_CANCELLED',
          'This request was cancelled. Please refresh to see the latest status.',
        );
      }

      // A cancellation (any status under metric_categories.cancel) is driven
      // by the source item owner and allowed only while update_count === 0.
      // Withdrawal is de-escalation, so it is not gated on either side's
      // liveness. Every other transition is a receiver response.
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

      // A cancellation is never a PII reveal, so it is not consent-gated even
      // if a network lists a cancel status in reveals_pii_on_status.
      const requiresReceiverConsent =
        !isCancellation && interaction.reveals_pii_on_status.includes(body.action_status);

      // U18 guardian gate, scoped to the accept / PII-reveal stage only. The
      // party gated is the accepting one (already checked to own the target
      // item), so the minor's own item is the gate's *source* and the other
      // party's the *target*, taken from the DB row. A minor initiator is gated
      // at perform. Adults and ungated domains resolve `not_required`.
      let guardianGate: GateResult = { status: 'not_required' };
      if (requiresReceiverConsent) {
        // In a bulk submit the pre-pass already produced this row's result.
        guardianGate =
          batchGate?.get(index) ??
          (await guardianActionGate({
            wardUserId: callerId,
            network: existingAction.target_item_network,
            sourceDomain: existingAction.target_item_domain,
            actionType: existingAction.action_type,
            sourceItemId: existingAction.target_item_id,
            targetItemId: existingAction.source_item_id,
            stage: 'accept',
            // Self-acted only, so the external-channel block does not apply.
            // If on-behalf is ever added here, pass the real channel so minors
            // are blocked.
            channel: 'self',
            otp: body.guardian_otp,
          }));

        // A per-item BulkItemFailure, never a mid-loop reply.send: runBulk
        // continues with later items, which would commit underneath a
        // whole-batch status that hides them.
        const guardianGateFail = guardianGateFailure(guardianGate);
        if (guardianGateFail) throw guardianGateFail;
      }

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
            consent_version: body.consent.version,
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

      // Optimistic concurrency: write only if update_count still matches what
      // was read. Source and target owners can both write (cancel vs accept),
      // so the loser gets ACTION_CONFLICT.
      //
      // Status update and accept-consent row share one transaction, so the
      // PII-revealing accept is never applied without a consent record. The
      // action event is emitted only after commit.
      const nextUpdateCount = existingAction.update_count + 1;
      const txOutcome = await db
        .transaction(async (tx) => {
          const [row] = await tx
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

          if (!row) return { kind: 'conflict' as const };

          if (requiresReceiverConsent && body.consent?.acknowledged) {
            // Version derived server-side from the loaded consent config, never
            // trusted from the client.
            const acceptVersion = await resolveConsentVersion({
              network: row.target_item_network,
              brand: body.consent.brand,
              category: 'action',
              actionType: row.action_type,
              stage: 'accept',
            });
            if (acceptVersion === null) {
              throw new ConsentWriteError(
                `accept consent version not configured for ${row.action_type}`,
              );
            }
            try {
              await tx.insert(consent_record).values(actionConsentRow({
                actionType: row.action_type,
                actionStage: 'accept',
                userId: callerId,
                itemId: row.target_item_id,
                actionId: body.action_id,
                network: row.target_item_network,
                brand: body.consent.brand ?? null,
                documentVersion: acceptVersion,
                source: 'action',
              }));
            } catch (err) {
              throw new ConsentWriteError(
                err instanceof Error ? err.message : 'consent write failed',
              );
            }
          }

          // Guardian accept-consent, only after a verified guardian OTP for
          // this accept. Same shape and fail-closed behaviour as the adult row
          // above, with `source:'guardian'` and the u18 metadata tag. Action
          // statements have no u18 variant, so the version comes from the
          // same resolver.
          if (guardianGate.status === 'verified') {
            const guardianVersion = await resolveConsentVersion({
              network: row.target_item_network,
              category: 'action',
              actionType: row.action_type,
              stage: 'accept',
            });
            if (guardianVersion === null) {
              throw new ConsentWriteError(
                `guardian accept consent version not configured for ${row.action_type}`,
              );
            }
            try {
              await tx.insert(consent_record).values(guardianActionConsentRow({
                actionType: row.action_type,
                actionStage: 'accept',
                userId: callerId,
                itemId: row.target_item_id,
                actionId: body.action_id,
                network: row.target_item_network,
                brand: body.consent?.brand ?? null,
                documentVersion: guardianVersion,
              }));
            } catch (err) {
              throw new ConsentWriteError(
                err instanceof Error ? err.message : 'guardian consent write failed',
              );
            }
          }

          return { kind: 'ok' as const, updatedAction: row };
        })
        .catch((err: unknown) => {
          if (err instanceof ConsentWriteError) return { kind: 'consentFailed' as const };
          throw err;
        });

      if (txOutcome.kind === 'conflict') {
        throw new BulkItemFailure(
          'ACTION_CONFLICT',
          'This request was updated by someone else; reload and try again.',
        );
      }
      if (txOutcome.kind === 'consentFailed') {
        throw new BulkItemFailure(
          'CONSENT_WRITE_FAILED',
          'Failed to record consent; the status change was not applied.',
        );
      }
      const updatedAction = txOutcome.updatedAction;

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

      // Accept-consent is recorded inside the status-update transaction above
      // (fail-closed), so the event below is emitted only after it committed.
      const createdEvent = await insertActionEvent(db, storedEvent);
      void mirrorActionEventToSourceInstance(storedEvent, request.log);

      // No email for a cancellation: it must not reuse the receiver-response
      // copy, and no cancellation copy exists yet.
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
