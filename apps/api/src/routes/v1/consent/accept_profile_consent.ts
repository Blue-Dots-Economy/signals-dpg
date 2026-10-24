import z, {
  ProfileConsentAcceptBodySchema,
  type ProfileConsentAcceptBody,
} from '@dpg/schemas';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { consent_record } from '@api/db/postgres/schema';
import { auth_middleware_if_enabled } from '@api/plugins/auth/auth_middleware';
import { apiConfig } from '@/config';
import { resolveConsentVersion } from '@/services/consent_version';
import { hasAcceptedTermsAndPrivacy } from '@/services/consent_acceptance';
import { promoteItemOnProfileConsent, isItemOwnedBy } from '@/services/item_service';
import { invalidateItemFetchCache } from '@/utils/item_fetch_cache_invalidate';
import { publishItemEvent } from '@/utils/publish_item_event';

const ProfileConsentAcceptResponseSchema = z.object({ recorded: z.number().int() });

type Req = FastifyRequest<{ Body: ProfileConsentAcceptBody }>;

export const accept_profile_consent: FastifyPluginAsyncZod = async (fastify) => {
  fastify.route({
    url: '/profile-accept',
    method: 'POST',
    preHandler: auth_middleware_if_enabled,
    schema: {
      tags: ['consent'],
      body: ProfileConsentAcceptBodySchema,
      response: {
        200: ProfileConsentAcceptResponseSchema,
      },
    },
    handler: accept_profile_consent_handler,
  });
};

export const accept_profile_consent_handler = async (
  request: Req,
  reply: FastifyReply,
) => {
  const userId = request.user?.id;
  if (!userId) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'Authenticated user is required',
    });
  }

  const body = request.body;

  const validNetworks = apiConfig.served_domains.map((b) => b.network);
  if (!validNetworks.includes(body.network)) {
    return reply.code(400).send({
      error: 'UNKNOWN_NETWORK',
      message: `Network "${body.network}" is not served by this instance`,
    });
  }

  // Verify ownership: the item must exist and be owned by the caller. Use the
  // partition key columns (item_network + item_domain + item_type + item_id) so
  // the planner can prune partitions.
  try {
    if (!(await isItemOwnedBy(userId, body))) {
      return reply.code(403).send({
        error: 'NOT_ITEM_OWNER',
        message: 'You do not own this item or it does not exist',
      });
    }
  } catch (err) {
    request.log.error({ err }, 'profile consent ownership check failed');
    return reply.code(500).send({
      error: 'CONSENT_READ_FAILED',
      message: 'Failed to verify item ownership',
    });
  }

  // Prerequisite: terms + privacy must already be accepted before per-profile
  // consent can be recorded. This enforces the invariant that lets the live
  // gate check profile_creation alone (see hasAcceptedProfileConsent).
  try {
    const prereqMet = await hasAcceptedTermsAndPrivacy(db, userId, body.network);
    if (!prereqMet) {
      return reply.code(409).send({
        error: 'CONSENT_PREREQUISITE_MISSING',
        message:
          'Terms and privacy must be accepted before recording profile consent',
      });
    }
  } catch (err) {
    request.log.error({ err }, 'profile consent prerequisite check failed');
    return reply.code(500).send({
      error: 'CONSENT_READ_FAILED',
      message: 'Failed to verify consent prerequisite',
    });
  }

  // Idempotency: return recorded:0 if a row already exists for this
  // (userId, item_id, profile_creation).
  try {
    const existing = await db
      .select({ id: consent_record.id })
      .from(consent_record)
      .where(
        and(
          eq(consent_record.userId, userId),
          eq(consent_record.level, 'item'),
          eq(consent_record.consentCategory, 'profile_creation'),
          eq(consent_record.itemId, body.item_id),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      return reply.code(200).send({ recorded: 0 });
    }
  } catch (err) {
    request.log.error({ err }, 'profile consent idempotency check failed');
    return reply.code(500).send({
      error: 'CONSENT_READ_FAILED',
      message: 'Failed to check existing consent',
    });
  }

  // Version derived server-side from the loaded consent config, never trusted
  // from the client.
  const profileVersion = await resolveConsentVersion({
    network: body.network,
    brand: body.brand,
    category: 'profile_creation',
  });
  if (profileVersion === null) {
    return reply.code(400).send({
      error: 'CONSENT_VERSION_UNCONFIGURED',
      message: `No profile_creation consent version configured for ${body.network}`,
    });
  }

  let promoted = false;
  try {
    await db.transaction(async (tx) => {
      await tx.insert(consent_record).values({
        level: 'item',
        consentCategory: 'profile_creation',
        userId,
        itemId: body.item_id,
        network: body.network,
        brand: body.brand ?? null,
        documentVersion: profileVersion,
        source: 'profile',
        acceptedAt: new Date(),
      });
      // Profile consent can make a complete draft live. Promote in the same
      // transaction so the ledger write and lifecycle flip are atomic.
      promoted = await promoteItemOnProfileConsent(tx, body.item_id);
    });
  } catch (err) {
    // The idempotency check and insert are not atomic, so a concurrent
    // double-submit can hit a unique violation (23505); only that is treated
    // as already-recorded. Any other insert error is a real failure and must
    // not be masked as success, or the UI would proceed past the consent modal.
    const e = err as { code?: string } | null;
    if (e?.code === '23505') {
      request.log.warn(
        { err, pg_code: e.code },
        'profile consent insert hit 23505 post-idempotency-check; treating as already recorded',
      );
      return reply.code(200).send({ recorded: 0 });
    }

    request.log.error({ err, pg_code: e?.code }, 'profile consent insert failed');
    return reply.code(500).send({
      error: 'CONSENT_WRITE_FAILED',
      message: 'Failed to record consent',
    });
  }

  // A promotion leaves a stale `draft` in both item read caches (the 1 s local
  // one and the domain-TTL inter-instance ones). Best-effort: a cache failure
  // must never fail an already-recorded consent.
  if (promoted) {
    await invalidateItemFetchCache(body.network, body.item_domain).catch((err) =>
      request.log.warn(
        { err },
        'cache invalidation after profile-consent promotion failed',
      ),
    );

    // signals-search maintains item_search from item events; without this the
    // profile stays `draft` there while `items` says `live`. Published after
    // the transaction, never inside it, so the worker cannot re-index the
    // pre-promotion row.
    await publishItemEvent(
      {
        item_network: body.network,
        item_domain: body.item_domain,
        item_type: body.item_type,
        item_id: body.item_id,
        op: 'upsert',
      },
      request.log,
    ).catch((err) =>
      request.log.warn({ err }, 'item event publish after profile-consent promotion failed'),
    );
  }

  return reply.code(200).send({ recorded: 1 });
};
