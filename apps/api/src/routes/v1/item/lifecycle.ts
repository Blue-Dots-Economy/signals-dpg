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
import { publishItemEvent } from '@/utils/publish_item_event';

type ItemLifecycleRequest = FastifyRequest<{
  Body: z.infer<typeof ItemLifecycleBody>;
}>;

export const item_lifecycle: FastifyPluginAsyncZod = async function (fastify) {
  // Order matters: auth_middleware_if_enabled populates `request.user` from the
  // apikey / session, which acting_org_preHandler_optional reads via
  // `request.user.id` to validate the service user. Both are registered as
  // plugin-level hooks so they fire before the route handler. Auth is
  // idempotent — the per-route preHandler below is a no-op second pass kept
  // for local readability.
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

      const current = existing.lifecycle_status as 'draft' | 'live' | 'paused' | 'retired';

      // Retire is terminal (#347): no transition out of `retired`, and any
      // other transition on an already-retired item is meaningless.
      if (current === 'retired') {
        return { invalidAction: 'ALREADY_RETIRED' as const } as const;
      }

      if (action === 'pause') {
        // Network-wide feature gate (#346). Resume stays allowed even when the
        // feature is off, so a profile paused earlier can still be recovered.
        const networkConfig = await getNetworkConfigById(existing.item_network);
        if (!networkConfig.pause_enabled) {
          return { invalidAction: 'PAUSE_NOT_ENABLED' as const } as const;
        }
        // Pause is a "voluntarily hide a *ready* profile" action — only a `live`
        // profile can be hidden (business R7.5 / #234 Q6). Hiding a draft (never
        // ready) or an already-paused profile is meaningless.
        if (current !== 'live') {
          return { invalidAction: 'PAUSE_REQUIRES_LIVE' as const } as const;
        }
      }
      if (action === 'unpause' && current !== 'paused') {
        return { invalidAction: 'UNPAUSE_REQUIRES_PAUSED' as const } as const;
      }

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

      let next_status: 'draft' | 'live' | 'paused' | 'retired';

      if (action === 'retire') {
        next_status = 'retired';

        // PII wipe (#347 Q9): keep only non-PII public fields; drop every
        // private:true field + the standard identity keys; clear the encrypted
        // private blob. Jittered location stays (item_locations column, kept).
        const scrubbedState = buildRetiredItemState(
          itemSchema as Record<string, unknown>,
          existing.item_state as Record<string, unknown>,
        );

        // End established connections (R9.3): cancel still-open actions on
        // either side; rows are kept for counterparty history (Q11).
        await cancelItemConnections(tx, item_id, request.log);

        await tx
          .update(items)
          .set({
            lifecycle_status: next_status,
            item_state: scrubbedState,
            // Clear the encrypted PII blob. The column is NOT NULL default '',
            // so empty string is the "no private state" value (see item create).
            item_private_state: '',
            // Stopgap for the retire moment until the telemetry pipeline lands
            // (marker below); `updated_at` freezes here since retired is terminal.
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
        };
      }

      if (action === 'pause') {
        next_status = 'paused';
      } else {
        // unpause: recompute draft/live from current data (non-sticky path).
        const consent_accepted = await hasAcceptedProfileConsent(tx, item_id);
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

    // De-index a retired profile from search (#347 R9.5): the item_search index
    // is maintained by the signals-search service off item events, so publish a
    // `delete` to drop it from discovery. Best-effort (never fails the retire).
    if (result.retired) {
      await publishItemEvent(
        {
          item_network: result.item_network,
          item_domain: result.item_domain,
          item_type: result.item_type,
          item_id: result.item_id,
          op: 'delete',
        },
        request.log,
      );
    }

    // Lifecycle transitions (pause / unpause / retire here, and the draft/live
    // transitions elsewhere) must be emitted as audit/telemetry events —
    // #234 Q15 ("log every transition as an event") / business doc R10.3.
    // Deferred to the cross-cutting events/telemetry pipeline so all
    // transitions report through one emitter; wire this transition
    // (from `result.previous_status` → `result.lifecycle_status`, actor
    // `callerId`) in there. `previous_status` is carried on `result` for that.
    // Until then, `updated_at` is bumped on the row as the retire timestamp.

    const {
      item_network: _n,
      item_domain: _d,
      item_type: _t,
      previous_status: _p,
      retired: _r,
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
