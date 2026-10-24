import { type FastifyPluginCallbackZod } from 'fastify-type-provider-zod';
import z, {
  CreateItemBodySchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition } from '@dpg/database';
import { consent_record } from '@api/db/postgres/schema';
import { resolveConsentVersion } from '@/services/consent_version';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { publishItemEvent } from '@/utils/publish_item_event';
import {
  assertSuppliedLocationsInCountry,
  createItemInternal,
  ItemServiceError,
  resolveGoLiveGates,
} from '@/services/item_service';
import { tagUserWithDefaultAggregator } from '@/services/aggregator/default_aggregator';
import { resolveLocationsForCreate } from '@/services/geocoding/resolve_locations_for_create';
import { getWardAge } from '@/services/minor_guardian_repo';
import { isMinor, guardianConsentRequired } from '@/services/minor';
import { getNetworkConfigById } from '@/network_configs';

type CreateItemRequest = FastifyRequest<{
  Body: z.infer<typeof CreateItemBodySchema>;
}>;

/**
 * Thrown inside the create transaction when the consent row cannot be written,
 * so the item insert rolls back with it (fail-closed — no PII item without a
 * consent record).
 */
class ConsentWriteError extends Error {}

// Callback-style: registering a route is synchronous, so there is nothing to
// await (an async plugin with no await is Sonar S7503).
export const create_item: FastifyPluginCallbackZod = function (fastify, _opts, done) {
  fastify.route({
    url: '/create',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['item'],
      body: CreateItemBodySchema,
      response: {
        201: z.object({
          item_type: z.string(),
          item_id: z.string(),
        }),
      },
    },
    handler: create_item_handler,
  });
  done();
};

/** Maps a create-item failure to its HTTP status + error body, logging where appropriate. */
function mapCreateItemError(
  err: unknown,
  log: CreateItemRequest['log'],
  body: unknown,
): { status: number; body: { error: string; message: string } } {
  if (err instanceof ConsentWriteError) {
    log.error({ err }, 'consent write failed; item creation rolled back (fail-closed)');
    return {
      status: 500,
      body: {
        error: 'CONSENT_WRITE_FAILED',
        message: 'Failed to record consent; the item was not created.',
      },
    };
  }
  if (err instanceof ItemServiceError) {
    // `details` carries a published error shape's extra fields (e.g.
    // DOMAIN_LOCKED's `locked_domain` / `requested_domain`). Spread first so it
    // cannot override the error code or message.
    return {
      status: err.statusCode,
      body: { ...err.details, error: err.errorCode, message: err.message },
    };
  }
  if (err instanceof DrizzleQueryError && err.cause instanceof DatabaseError) {
    // 23505 = unique_violation (fallback safety), 23503 = foreign_key_violation.
    if (err.cause.code === '23505') {
      return {
        status: 409,
        body: {
          error: 'ITEM_ALREADY_EXISTS',
          message: 'An item with the same type and id already exists',
        },
      };
    }
    if (err.cause.code === '23503') {
      return {
        status: 400,
        body: {
          error: 'INVALID_REFERENCE',
          message:
            'One or more referenced entities do not exist, including the authenticated user',
        },
      };
    }
  }
  log.error({ err, body }, 'Failed to create item');
  return { status: 500, body: { error: 'INTERNAL_SERVER_ERROR', message: 'Failed to create item' } };
}

/**
 * Whether a consent-less self-create must be rejected: true iff the domain
 * gates go-live on `consent_required` AND a profile_creation consent version is
 * configured (nothing to accept ⇒ not demanded).
 */
async function selfCreateNeedsConsent(body: CreateItemRequest['body']): Promise<boolean> {
  const gates = await resolveGoLiveGates(body.item_network, body.item_domain);
  if (!gates.includes('consent_required')) return false;
  const requiredVersion = await resolveConsentVersion({
    network: body.item_network,
    category: 'profile_creation',
  });
  return requiredVersion !== null;
}

/**
 * Whether a create that carries consent may promote straight to `live`. On a
 * guardian-gated domain only a proven adult self-promotes; a minor or unknown
 * age stays draft until guardian consent (fail-closed).
 */
async function resolveSelfConsentPromotes(
  body: CreateItemRequest['body'],
  userId: string,
): Promise<boolean> {
  if (body.consent == null) return false;
  const networkConfig = await getNetworkConfigById(body.item_network);
  if (!guardianConsentRequired(networkConfig, body.item_domain)) return true;
  const age = await getWardAge(userId);
  return !(age === null || isMinor(age));
}

export const create_item_handler = async (
  request: CreateItemRequest,
  reply: FastifyReply
) => {
  const callerId = request.user?.id;
  const callerRole = request.user?.role;
  const body = request.body;

  if (!callerId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required to create an item',
    });
  }

  // Creating on behalf of another user (`created_by`) is reserved for admin
  // api-key callers. A UI session owns what it creates even when the user has
  // an admin role, so a signed-in admin creating their own profile does not
  // hit CREATED_BY_REQUIRED.
  const isApiKeyCaller = Boolean(request.headers['x-api-key']);
  const isAdminApiCaller = isApiKeyCaller && callerRole === 'admin';

  if (!isAdminApiCaller && body.created_by) {
    return reply.code(403).send({
      error: 'FORBIDDEN_CREATED_BY',
      message: 'created_by may only be set by an admin api-key caller',
    });
  }

  if (isAdminApiCaller && !body.created_by) {
    return reply.code(400).send({
      error: 'CREATED_BY_REQUIRED',
      message: 'created_by is required when an admin api-key creates an item',
    });
  }

  const userId = isAdminApiCaller ? (body.created_by as string) : callerId;

  // A self create must carry consent when the domain gates go-live on
  // `consent_required` and a profile_creation statement is configured: the
  // UI's consent gate is client-side only, so this is the server-side
  // guarantee. The admin on-behalf (bulk) path is exempt; those participants
  // are gated at first login.
  if (!isAdminApiCaller && !body.consent && (await selfCreateNeedsConsent(body))) {
    return reply.code(400).send({
      error: 'CONSENT_REQUIRED',
      message: 'profile_creation consent is required to create this item',
    });
  }

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  try {
    await ensureItemPartition(
      db,
      body.item_network,
      body.item_domain
    );
  } catch (err) {
    request.log.error(
      {
        err,
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
      },
      'Failed to ensure item partition'
    );

    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'Failed to prepare storage for item type',
    });
  }

  // Caller-resolved coordinates skip the geocoder, so they are held to the
  // configured country here instead.
  try {
    await assertSuppliedLocationsInCountry(body.item_locations);
  } catch (err) {
    const mapped = mapCreateItemError(err, request.log, body);
    return reply.code(mapped.status).send(mapped.body);
  }

  // Backend geocoding: resolve coordinates from the schema's location field when
  // the client supplied none. Shared with the admin-participant onboarding path
  // (create_profile_item) so both store item_locations identically.
  const item_locations = await resolveLocationsForCreate({
    item_network: body.item_network,
    item_domain: body.item_domain,
    item_type: body.item_type,
    item_state: body.item_state ?? {},
    provided: body.item_locations,
    log: request.log,
  });

  const selfConsentPromotes = await resolveSelfConsentPromotes(body, userId);

  try {
    // Item + consent in one transaction: a consent-write failure rolls the item
    // back (never a PII item without a consent row). Event and cache
    // invalidation happen only after commit.
    const created = await db.transaction(async (tx) => {
      // Tag the user with the default aggregator before the item is
      // classified: `classify_item` reads the tag through `owner_required`, so
      // otherwise a new signup's first profile lands in `draft`.
      //
      // Runs on every create, not just the first, so users who signed up
      // before a default was nominated still get tagged; the `IS NULL` guard
      // makes it a no-op for an already-owned user. Uses the request's network
      // because deriving it from the bare domain is ambiguous when two served
      // networks declare the same domain.
      await tagUserWithDefaultAggregator(tx, userId, body.item_network, body.item_domain);

      const c = await createItemInternal(tx, {
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
        item_state: body.item_state ?? {},
        item_locations,
        created_by: userId,
        // A consent block on create is the profile_creation acceptance (the
        // only create-time category), so classify with it now. Admin/bulk
        // callers omit it and stay draft until /consent/profile-accept; a
        // gated minor is forced draft.
        consent_accepted: selfConsentPromotes,
      });

      if (body.consent) {
        // Version is derived server-side from the loaded consent config, never
        // trusted from the client (the ledger stores only category + version).
        const profileVersion = await resolveConsentVersion({
          network: body.item_network,
          brand: body.consent.brand,
          category: 'profile_creation',
        });
        if (profileVersion === null) {
          throw new ConsentWriteError(
            `profile_creation consent version not configured for ${body.item_network}`,
          );
        }
        try {
          await tx.insert(consent_record).values({
            level: 'item',
            consentCategory: 'profile_creation',
            userId: callerId,
            itemId: c.itemId,
            network: body.item_network,
            brand: body.consent.brand ?? null,
            documentVersion: profileVersion,
            source: 'profile',
            acceptedAt: new Date(),
          });
        } catch (err) {
          throw new ConsentWriteError(err instanceof Error ? err.message : 'consent write failed');
        }
      }

      return c;
    });

    await publishItemEvent(
      {
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
        item_id: created.itemId,
        op: 'upsert',
      },
      request.log,
    );

    await invalidateItemFetchCache(body.item_network, body.item_domain).catch((err) =>
      request.log.warn({ err }, 'cache invalidation after create failed'),
    );

    // Owner-facing create email. Fire-and-forget after commit, lazy-imported to
    // keep the notification chain off this route's static graph. `userId` is
    // the resolved owner on both paths. `lifecycleStatus` picks "you're live"
    // vs "complete your profile", since a 201 can commit a draft.
    void import('@/notifications/notify_item_lifecycle')
      .then(({ dispatchItemLifecycleNotification }) =>
        dispatchItemLifecycleNotification(
          {
            op: 'create',
            ownerId: userId,
            itemId: created.itemId,
            domain: body.item_domain,
            network: body.item_network,
            actingOrgType: request.acting_org?.org_type ?? null,
            lifecycleStatus: created.lifecycleStatus,
          },
          request.log,
        ),
      )
      .catch((err) => request.log.warn({ err }, 'item-lifecycle notify (create) failed'));

    return reply.code(201).send({
      item_type: created.itemType,
      item_id: created.itemId,
    });
  } catch (err) {
    const mapped = mapCreateItemError(err, request.log, body);
    return reply.code(mapped.status).send(mapped.body);
  }
};
