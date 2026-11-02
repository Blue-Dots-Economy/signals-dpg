import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, { ItemLifecycleBody, ItemLifecycleResponse } from '@dpg/schemas';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { acting_org_preHandler_optional } from '@/middleware/acting_org_optional';
import { db } from '@api/db/postgres/drizzle_config';
import { items } from '@dpg/database';
import { eq, sql } from 'drizzle-orm';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { getOrFetchSchemaByUrl } from '@/network_schema_cache';
import { getNetworkConfigById } from '@/network_configs';
import { classify_item } from '@/services/items/classifier';
import { hasAcceptedProfileConsent } from '@/services/consent_acceptance';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { buildRetiredItemState } from '@/services/items/retire_pii';
import { cancelItemConnections } from '@/services/items/retire_connections';
import type { RetireCancelledCounterparty } from '@/services/items/retire_connections';
import { dispatchRetireCancelNotifications } from '@/notifications/notify_retire';
import { publishItemEvent } from '@/utils/publish_item_event';

type ItemLifecycleRequest = FastifyRequest<{
  Body: z.infer<typeof ItemLifecycleBody>;
}>;

export const item_lifecycle: FastifyPluginAsyncZod = async function (fastify) {
  // Order matters: auth populates `request.user`, which
  // acting_org_preHandler_optional reads. The per-route preHandler below is an
  // idempotent second pass kept for readability.
  fastify.addHook('preHandler', auth_middleware_if_enabled);
  fastify.addHook('preHandler', acting_org_preHandler_optional);

  fastify.route({
    url: '/lifecycle',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: ItemLifecycleBody,
      response: {
        200: ItemLifecycleResponse,
      },
    },
    handler: item_lifecycle_handler,
  });
};

const item_lifecycle_handler = async (
  request: ItemLifecycleRequest,
  reply: FastifyReply,
) => {
  const callerId = request.user?.id;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  }

  const isNetworkService = request.acting_org?.org_type === 'network_service';
  const { item_id, action } = request.body;

  // The item owner, the pause/retire email recipient (a network_service caller
  // can transition another user's item). Kept off `result` so it never reaches
  // the response body.
  let ownerCreatedBy: string | null = null;

  try {
    const result = await db.transaction(async (tx) => {
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
        return { notFound: true } as const;
      }

      const isOwner = existing.created_by === callerId;
      if (!isOwner && !isNetworkService) {
        return { forbidden: true } as const;
      }
      ownerCreatedBy = existing.created_by;

      const current = existing.lifecycle_status as 'draft' | 'live' | 'paused' | 'retired';

      // Retire is terminal.
      if (current === 'retired') {
        return { invalidAction: 'ALREADY_RETIRED' as const } as const;
      }

      if (action === 'pause') {
        // Network-wide feature gate. Unpause stays allowed when it is off, so a
        // profile paused earlier can still be recovered.
        const networkConfig = await getNetworkConfigById(existing.item_network);
        if (!networkConfig.pause_enabled) {
          return { invalidAction: 'PAUSE_NOT_ENABLED' as const } as const;
        }
        // Pause voluntarily hides a ready profile, so only `live` can be paused.
        if (current !== 'live') {
          return { invalidAction: 'PAUSE_REQUIRES_LIVE' as const } as const;
        }
      }
      if (action === 'unpause' && current !== 'paused') {
        return { invalidAction: 'UNPAUSE_REQUIRES_PAUSED' as const } as const;
      }

      let next_status: 'draft' | 'live' | 'paused' | 'retired';

      if (action === 'retire') {
        next_status = 'retired';

        // Retire does not decrypt item_private_state; it works off the stored
        // (masked) item_state, so an undecryptable private blob cannot block
        // the action meant to wipe it.
        const itemSchema = await getOrFetchSchemaByUrl({
          schemaUrl: existing.item_schema_url,
          network: existing.item_network,
          domain: existing.item_domain,
          itemType: existing.item_type,
        });

        // PII wipe: keep only schema-declared, non-PII public fields; drop
        // private:true fields, the standard identity keys (at any nesting) and
        // unknown keys. Action-embedded data (requirements_snapshot /
        // event_payload) is not handled here.
        const scrubbedState = buildRetiredItemState(
          itemSchema as Record<string, unknown>,
          existing.item_state as Record<string, unknown>,
        );

        // Cancel still-open actions on either side; rows are kept for
        // counterparty history. Counterparties are notified after commit.
        const cancelledCounterparties = await cancelItemConnections(
          tx,
          {
            item_id,
            item_network: existing.item_network,
            item_domain: existing.item_domain,
            item_type: existing.item_type,
          },
          request.log,
        );

        await tx
          .update(items)
          .set({
            lifecycle_status: next_status,
            item_state: scrubbedState,
            // NOT NULL default '': empty string is "no private state".
            item_private_state: '',
            // Wipe locations entirely: a non-private location keeps exact
            // coords, and jitter keeps the free-text label verbatim.
            item_locations: [],
            // Retired is terminal, so `updated_at` records the retire moment.
            updated_at: sql`now()`,
          })
          .where(eq(items.item_id, item_id));

        return {
          item_id,
          item_network: existing.item_network,
          item_domain: existing.item_domain,
          item_type: existing.item_type,
          previous_status: current,
          lifecycle_status: next_status,
          retired: true as const,
          counterparties: cancelledCounterparties,
        };
      }

      if (action === 'pause') {
        next_status = 'paused';
      } else {
        // unpause: recompute draft/live from the current (decrypted) data.
        const { mergedState } = decryptItemPrivate({
          item_state: existing.item_state as Record<string, unknown>,
          item_private_state: existing.item_private_state ?? '',
        });
        const itemSchema = await getOrFetchSchemaByUrl({
          schemaUrl: existing.item_schema_url,
          network: existing.item_network,
          domain: existing.item_domain,
          itemType: existing.item_type,
        });
        const consent_accepted = await hasAcceptedProfileConsent(tx, item_id);
        // No `gates` here, so only DEFAULT_GO_LIVE_GATES apply and
        // `owner_required` is not evaluated: resuming a profile that was live
        // must not be stricter than leaving it alone.
        next_status = classify_item({
          schema: itemSchema as { required?: string[] },
          merged_state: mergedState,
          current_status: 'draft',
          consent_accepted,
        }).lifecycle_status;
      }

      await tx
        .update(items)
        .set({
          lifecycle_status: next_status,
          updated_at: sql`now()`,
        })
        .where(eq(items.item_id, item_id));

      return {
        item_id,
        item_network: existing.item_network,
        item_domain: existing.item_domain,
        item_type: existing.item_type,
        previous_status: current,
        lifecycle_status: next_status,
        retired: false as const,
        counterparties: [] as RetireCancelledCounterparty[],
      };
    });

    if ('notFound' in result) {
      return reply.code(404).send({
        error: 'ITEM_NOT_FOUND',
        message: 'Item not found',
      });
    }

    if ('forbidden' in result) {
      return reply.code(403).send({
        error: 'ITEM_NOT_OWNED_BY_USER',
        message: 'You do not own this item',
      });
    }

    if ('invalidAction' in result) {
      const messages = {
        PAUSE_NOT_ENABLED: 'Pause is not enabled for this network',
        PAUSE_REQUIRES_LIVE: 'pause is only valid on a live item',
        UNPAUSE_REQUIRES_PAUSED: 'unpause is only valid on a paused item',
        ALREADY_RETIRED: 'this profile is retired and cannot change state',
      } as const;
      return reply.code(409).send({
        error:
          result.invalidAction === 'PAUSE_NOT_ENABLED'
            ? 'PAUSE_NOT_ENABLED'
            : 'INVALID_LIFECYCLE_ACTION',
        message: messages[result.invalidAction as keyof typeof messages],
      });
    }

    await invalidateItemFetchCache(result.item_network, result.item_domain).catch(
      (err) => request.log.warn({ err }, 'cache invalidation after lifecycle change failed'),
    );

    // Publish every transition: signals-search maintains item_search from item
    // events and `/v1/search` is live-only, so an unpublished pause would keep
    // a paused profile in search. Retire de-indexes (`delete`); everything else
    // `upsert`s. Best-effort: publishItemEvent swallows and warns, so a Redis
    // outage cannot fail a committed transition.
    await publishItemEvent(
      {
        item_network: result.item_network,
        item_domain: result.item_domain,
        item_type: result.item_type,
        item_id: result.item_id,
        op: result.retired ? 'delete' : 'upsert',
      },
      request.log,
    );

    if (result.retired) {
      // Fire-and-forget after commit. No-op when notifications are unconfigured
      // or a counterparty has no local email.
      void dispatchRetireCancelNotifications(
        result.counterparties,
        result.item_network,
        request.log,
      );
    }

    // Owner-facing pause/retire email, fire-and-forget after commit; unpause
    // does not notify. Sent to the owner, not the caller. Lazy-imported to keep
    // the notification chain out of the static graph.
    if ((action === 'pause' || action === 'retire') && ownerCreatedBy) {
      const op = action;
      const ownerId = ownerCreatedBy;
      void import('@/notifications/notify_item_lifecycle')
        .then(({ dispatchItemLifecycleNotification }) =>
          dispatchItemLifecycleNotification(
            {
              op,
              ownerId,
              itemId: result.item_id,
              domain: result.item_domain,
              network: result.item_network,
            },
            request.log,
          ),
        )
        .catch((err) => request.log.warn({ err }, 'item-lifecycle notify (lifecycle) failed'));
    }

    // Transitions are not yet emitted as audit/telemetry events;
    // `previous_status` is carried on `result` for that emitter.

    const {
      item_network: _n,
      item_domain: _d,
      item_type: _t,
      previous_status: _p,
      retired: _r,
      counterparties: _c,
      ...responseBody
    } = result;
    return reply.code(200).send(responseBody);
  } catch (err) {
    request.log.error({ err, item_id, action }, 'Failed to update item lifecycle');

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to update item lifecycle',
    });
  }
};
