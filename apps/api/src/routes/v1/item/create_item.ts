import { type FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import z, {
  CreateItemBodySchema,
} from '@dpg/schemas';
import { FastifyReply, FastifyRequest } from 'fastify';
import { db } from '@api/db/postgres/drizzle_config';
import { DrizzleQueryError, and, eq, sql } from 'drizzle-orm';
import { DatabaseError, ensureItemPartition } from '@dpg/database';
import { consent_record, user } from '@api/db/postgres/schema';
import { resolveConsentVersion } from '@/services/consent_version';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import {
  isServedDomainBinding,
  replyForUnservedDomain,
} from '@/utils/served_domain_guard';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { publishItemEvent } from '@/utils/publish_item_event';
import { createItemInternal, ItemServiceError, resolveGoLiveGates } from '@/services/item_service';
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

export const create_item: FastifyPluginAsyncZod = async function (fastify) {
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
};

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

  // The "admin acting on behalf of another user" flow is reserved for
  // server-to-server callers identified by an api-key. UI sessions — even
  // when the logged-in user happens to carry an admin role — should behave
  // like a normal user and own the items they create. Distinguishing on
  // the api-key header keeps that contract explicit and avoids confusing
  // signed-in admins with a CREATED_BY_REQUIRED error when they create
  // their own profile.
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

  // A direct/self create (session user or api-key-as-self) must carry consent
  // when the domain gates go-live on `consent_required` AND the network
  // configures a profile_creation statement — the login/gate safety net is
  // UI-only, so this is the server-side guarantee. The admin on-behalf (bulk)
  // path is exempt: those participants are gated at first login. A domain whose
  // `go_live_required` omits `consent_required` (e.g. a provider configured
  // `["schema_required"]`) goes live on completeness alone, so consent is not
  // demanded at create; and when no profile_creation consent is configured
  // there is nothing to accept.
  if (!isAdminApiCaller && !body.consent) {
    const gates = await resolveGoLiveGates(body.item_network, body.item_domain);
    if (gates.includes('consent_required')) {
      const requiredVersion = await resolveConsentVersion({
        network: body.item_network,
        category: 'profile_creation',
      });
      if (requiredVersion !== null) {
        return reply.code(400).send({
          error: 'CONSENT_REQUIRED',
          message: 'profile_creation consent is required to create this item',
        });
      }
    }
  }

  if (!isServedDomainBinding(body.item_network, body.item_domain)) {
    return await replyForUnservedDomain(
      reply,
      body.item_network,
      body.item_domain
    );
  }

  // Single-role lock, driven by `user.domains` (the source of truth, persisted
  // at signup / bootstrapped on first create below). A user may create profiles
  // only in the domain(s) on their user row. The column is an array for a
  // FUTURE multi-role case, but today it holds exactly one entry and this never
  // grows it, so the role stays single. Empty => not yet set, so any served
  // domain is allowed and the first create records it. Admin api-key callers
  // bypass — they act on behalf of a user with explicit intent.
  if (!isAdminApiCaller) {
    const [row] = await db
      .select({ domains: user.domains })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const allowed = row?.domains ?? [];
    if (allowed.length > 0 && !allowed.includes(body.item_domain)) {
      return reply.code(403).send({
        error: 'DOMAIN_LOCKED',
        message: `You are registered as "${allowed[0]}" and cannot create items under "${body.item_domain}".`,
        locked_domain: allowed[0],
        requested_domain: body.item_domain,
      });
    }
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

  // U18 fail-closed: a self-consent create must NOT promote a gated MINOR to
  // live — only GUARDIAN consent (recorded via the finalize/accept path) does.
  // So a consenting create by a gated minor is still written draft; everyone
  // else keeps the #275 behaviour (consenting create goes live now).
  let selfConsentPromotes = body.consent != null;
  if (selfConsentPromotes) {
    const networkConfig = await getNetworkConfigById(body.item_network);
    if (guardianConsentRequired(networkConfig, body.item_domain)) {
      // Gated domain is fail-closed: only a PROVEN adult self-promotes to live.
      // A minor needs guardian consent; a null age cannot prove adulthood (age
      // capture is client-side only) → both stay draft. Mirrors
      // guardianGateBlocksGoLive on the promote/update paths.
      const age = await getWardAge(userId);
      if (age === null || isMinor(age)) selfConsentPromotes = false;
    }
  }

  try {
    // Item + consent are written in one transaction so a consent-write failure
    // rolls the item back too (fail-closed — never a PII item without a consent
    // row). The item event/cache-invalidation happen only after commit.
    const created = await db.transaction(async (tx) => {
      const c = await createItemInternal(tx, {
        item_network: body.item_network,
        item_domain: body.item_domain,
        item_type: body.item_type,
        item_state: body.item_state ?? {},
        item_locations,
        created_by: userId,
        // A self-create that carries consent IS the profile_creation acceptance,
        // so classify with it now (#275 gated `live` on consent but never let
        // the create path see it → profiles were stuck `draft`). Keyed on
        // presence, not `body.consent.category`: the consent row + version are
        // server-resolved to `profile_creation` (the only create-time consent
        // category), so any consent block present is that acceptance. The row is
        // written just below in the same transaction; a consent-write failure
        // rolls the whole create back (fail-closed). Admin/bulk callers omit
        // this and stay draft, promoted later via /consent/profile-accept.
        // A gated minor is forced draft (see selfConsentPromotes above).
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

      // Bootstrap the single role on the user's first create so `user.domains`
      // stays the source of truth for the lock. Sets only when unset; never
      // grows to a second domain, so the role stays single.
      await tx
        .update(user)
        .set({ domains: [body.item_domain], updatedAt: new Date() })
        .where(
          and(
            eq(user.id, userId),
            sql`(${user.domains} IS NULL OR cardinality(${user.domains}) = 0)`,
          ),
        );

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

    return reply.code(201).send({
      item_type: created.itemType,
      item_id: created.itemId,
    });
  } catch (err) {
    if (err instanceof ConsentWriteError) {
      request.log.error(
        { err, item_network: body.item_network, item_type: body.item_type },
        'consent write failed; item creation rolled back (fail-closed)',
      );
      return reply.code(500).send({
        error: 'CONSENT_WRITE_FAILED',
        message: 'Failed to record consent; the item was not created.',
      });
    }
    if (err instanceof ItemServiceError) {
      return reply.code(err.statusCode).send({
        error: err.errorCode,
        message: err.message,
      });
    }
    if (err instanceof DrizzleQueryError) {
      const cause = err.cause;

      if (cause instanceof DatabaseError) {
        // 23505 = unique_violation (fallback safety)
        if (cause.code === '23505') {
          return reply.code(409).send({
            error: 'ITEM_ALREADY_EXISTS',
            message: 'An item with the same type and id already exists',
          });
        }

        // 23503 = foreign_key_violation
        if (cause.code === '23503') {
          return reply.code(400).send({
            error: 'INVALID_REFERENCE',
            message:
              'One or more referenced entities do not exist, including the authenticated user',
          });
        }
      }
    }

    request.log.error({ err, body }, 'Failed to create item');

    return reply.code(500).send({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to create item',
    });
  }
};
