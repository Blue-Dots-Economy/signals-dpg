import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { ensureItemPartition, items } from '@dpg/database';
import { sql } from 'drizzle-orm';
import { user } from '../../../../db/postgres/schema/auth.js';
import { authInstance } from '@/routes/auth/create_auth';
import { create_profile_item } from '@/lib/profile_item';
import { updateItemInternal } from '@/services/item_service';
import { apiConfig } from '@/config';
import {
  UpsertParticipantRequest,
  UpsertParticipantResponse,
  type UpsertParticipantRequest as UpsertBody,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { resolve_upsert_action } from './_resolve_upsert_action.js';

/**
 * POST /api/v1/admin/participant
 *
 * Plan C — Tier-aware upsert that replaces /admin/onboard_participant.
 * The handler dispatches on `resolve_upsert_action`'s verdict (5 kinds)
 * + an additional runtime ownership check for the update_item branch
 * that produces 403 ITEM_NOT_OWNED_BY_USER.
 */
type UpsertRequest = FastifyRequest<{ Body: UpsertBody }>;

export const participant: FastifyPluginAsync = async (app) => {
  app.route({
    url: '/participant',
    method: 'POST',
    schema: {
      tags: ['admin'],
      body: UpsertParticipantRequest,
      response: { 200: UpsertParticipantResponse },
    },
    handler: participant_handler,
  });
};

export const participant_handler = async (
  request: UpsertRequest,
  reply: FastifyReply,
) => {
  const body = request.body;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  const phone_norm = body.phone_number?.trim() ?? null;

  // Defensive — schema refine should have caught this.
  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  // 1. Look up existing user.
  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause =
    conditions.length === 1 ? conditions[0] : or(...conditions);

  const existingRows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      onboardedByOrgId: user.onboardedByOrgId,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  const existing = existingRows[0] ?? null;
  const user_exists = Boolean(existing);

  // 2. Dispatch on the helper's verdict.
  const verdict = resolve_upsert_action({
    acting_org: request.acting_org,
    user_exists,
    item_id_in_body: body.item_id,
  });

  if (verdict.kind === 'rejected') {
    return reply.code(verdict.status).send({
      error: verdict.error,
      message:
        verdict.error === 'INVALID_ACTING_ORG'
          ? 'acting_org is required for /admin/participant'
          : 'only aggregator or network_service acting orgs are allowed',
    });
  }

  // 3. Verdict-specific branches.
  if (verdict.kind === 'aggregator_existing_noop') {
    const acting_org_id = request.acting_org!.org_id;
    const isOwn = existing!.onboardedByOrgId === acting_org_id;
    const itemsList = isOwn ? await readItemsForUser(existing!.id) : [];
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      onboarded_at: null,
      items: itemsList,
    });
  }

  if (verdict.kind === 'update_item') {
    // Runtime ownership check — pre-flight ahead of updateItemInternal so
    // mismatches produce 403 ITEM_NOT_OWNED_BY_USER rather than 404.
    const [ownerRow] = await db
      .select({ created_by: items.created_by })
      .from(items)
      .where(eq(items.item_id, verdict.item_id))
      .limit(1);
    if (!ownerRow || ownerRow.created_by !== existing!.id) {
      return reply.code(403).send({
        error: 'ITEM_NOT_OWNED_BY_USER',
        message: 'item_id does not belong to the resolved user',
      });
    }

    try {
      await updateItemInternal(
        db,
        verdict.item_id,
        existing!.id,
        true, // isAdmin — ownership already verified above
        { item_state: body.item_state },
      );
    } catch (err) {
      const e = err as { statusCode?: number; errorCode?: string };
      const isClientError =
        typeof e.statusCode === 'number' &&
        e.statusCode >= 400 &&
        e.statusCode < 500;
      const logger = isClientError ? request.log.warn : request.log.error;
      logger.call(
        request.log,
        { err, item_id: verdict.item_id },
        'updateItemInternal failed',
      );
      return reply.code(e.statusCode ?? 500).send({
        error: e.errorCode ?? 'UPDATE_FAILED',
        message: (err as Error).message ?? 'item update failed',
      });
    }

    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      onboarded_at: null,
      items: itemsList,
    });
  }

  if (verdict.kind === 'insert_item') {
    const network = body.network ?? 'blue_dot';
    const domain = body.domain ?? 'seeker';
    const item_type = body.item_type ?? 'profile_1.0';

    // Domain mismatch guard: user.domains carries at most one "network/X"
    // entry per network. Reject if there's already one with a different
    // domain in this network. If absent, append it alongside the insert.
    const userRow = await db
      .select({ domains: user.domains })
      .from(user)
      .where(eq(user.id, existing!.id))
      .limit(1);

    const currentDomains = userRow[0]?.domains ?? [];
    const networkPrefix = `${network}/`;
    const matched = currentDomains.find((d) => d.startsWith(networkPrefix));
    const requestedBinding = `${network}/${domain}`;

    if (matched && matched !== requestedBinding) {
      const registeredDomain = matched.slice(networkPrefix.length);
      return reply.code(409).send({
        error: 'DOMAIN_MISMATCH',
        message: `user already registered as "${registeredDomain}" in "${network}"; refusing to create "${domain}" item`,
        registered_domain: registeredDomain,
        requested_domain: domain,
      });
    }

    try {
      await ensureItemPartition(db, network, domain);
    } catch (err) {
      request.log.error(
        { err, network, domain },
        'failed to ensure item partition',
      );
      return reply.code(500).send({
        error: 'PARTITION_SETUP_FAILED',
        message: 'failed to prepare storage for item type',
      });
    }
    try {
      await db.transaction(async (tx) => {
        await create_profile_item({
          tx,
          user_id: existing!.id,
          network,
          domain,
          item_type,
          payload: body.item_state,
        });
        if (!matched) {
          // Append "network/domain" if absent; array_append is idempotent
          // enough for our purposes — the prior check + tx scope keeps it
          // race-safe.
          await tx.execute(sql`
            UPDATE "user"
            SET domains = ARRAY(
              SELECT DISTINCT unnest(domains || ARRAY[${requestedBinding}]::text[])
            )
            WHERE id = ${existing!.id}
          `);
        }
      });
    } catch (err) {
      const e = err as { statusCode?: number; errorCode?: string };
      const isClientError =
        typeof e.statusCode === 'number' &&
        e.statusCode >= 400 &&
        e.statusCode < 500;
      const logger = isClientError ? request.log.warn : request.log.error;
      logger.call(request.log, { err }, 'insert_item failed');
      return reply.code(e.statusCode ?? 500).send({
        error: e.errorCode ?? 'INSERT_ITEM_FAILED',
        message: (err as Error).message ?? 'item insert failed',
      });
    }
    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      onboarded_at: null,
      items: itemsList,
    });
  }

  // verdict.kind === 'create_new_user'
  const acting_org_id = request.acting_org!.org_id;
  const network = body.network ?? 'blue_dot';
  const domain = body.domain ?? 'seeker';
  const item_type = body.item_type ?? 'profile_1.0';

  try {
    await ensureItemPartition(db, network, domain);
  } catch (err) {
    request.log.error(
      { err, network, domain },
      'failed to ensure item partition',
    );
    return reply.code(500).send({
      error: 'PARTITION_SETUP_FAILED',
      message: 'failed to prepare storage for item type',
    });
  }

  const now = new Date();
  const email_for_signup = email_norm ?? `${randomUUID()}@no-email.local`;

  let user_id: string;
  try {
    const signed_up = await authInstance.api.signUpEmail({
      body: {
        email: email_for_signup,
        password: randomUUID(),
        name: body.name,
      },
    });
    user_id = signed_up.user.id;
  } catch (signupErr: unknown) {
    const e = signupErr as {
      code?: string;
      cause?: { code?: string };
      message?: string;
    } | null;
    const pg_code = e?.code ?? e?.cause?.code;
    const message = String(e?.message ?? '');
    if (
      pg_code === '23505' ||
      message.includes('duplicate key value') ||
      message.includes('unique constraint')
    ) {
      request.log.warn({ err: signupErr }, 'signUp race; user exists now');
      return reply.code(409).send({
        error: 'USER_ALREADY_EXISTS',
        message:
          'email or phone already in use (race) — retry the request',
      });
    }
    request.log.error(
      { err: signupErr },
      'signUp failed during onboarding',
    );
    return reply.code(500).send({
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    });
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(user)
        .set({
          phoneNumber: phone_norm,
          phoneNumberVerified: false,
          dateOfBirth: body.date_of_birth ? new Date(body.date_of_birth) : null,
          termsAccepted: true,
          privacyAccepted: true,
          onboardedByOrgId: acting_org_id,
          onboardedVia: body.channel,
          onboardedSourceId: body.source_id ?? null,
          onboardedAt: now,
          domains: [`${network}/${domain}`],
          updatedAt: now,
        })
        .where(eq(user.id, user_id));

      await create_profile_item({
        tx,
        user_id,
        network,
        domain,
        item_type,
        payload: body.item_state,
      });
      // user.domains was seeded above in the same UPDATE — nothing more
      // to record here.
    });
  } catch (txErr: unknown) {
    try {
      await db.delete(user).where(eq(user.id, user_id));
      request.log.warn(
        { orphan_user_id: user_id },
        'cleaned up orphan user after tx rolled back',
      );
    } catch (cleanupErr) {
      request.log.error(
        { cleanupErr, orphan_user_id: user_id },
        'failed to clean up orphan user — manual cleanup needed',
      );
    }
    const e = txErr as {
      code?: string;
      message?: string;
      cause?: { code?: string };
      statusCode?: number;
      errorCode?: string;
    } | null;
    if (e?.statusCode && e?.errorCode) {
      return reply.code(e.statusCode).send({
        error: e.errorCode,
        message: e.message ?? 'request rejected',
      });
    }
    const pg_code = e?.code ?? e?.cause?.code;
    const message = String(e?.message ?? '');
    if (
      pg_code === '23505' ||
      message.includes('duplicate key value') ||
      message.includes('unique constraint')
    ) {
      return reply.code(409).send({
        error: 'USER_ALREADY_EXISTS',
        message: 'email or phone already in use (race)',
      });
    }
    request.log.error({ err: txErr }, 'participant onboard failed in tx');
    return reply.code(500).send({
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    });
  }

  const itemsList = await readItemsForUser(user_id);
  return reply.code(200).send({
    user_id,
    user_existed: false,
    onboarded_at: now.toISOString(),
    items: itemsList,
  });
};

// --- helpers ---

const servedNetworks = (): string[] => {
  const set = new Set<string>();
  for (const d of apiConfig.served_domains) set.add(d.network);
  return Array.from(set);
};

async function readItemsForUser(user_id: string) {
  const networks = servedNetworks();
  const rows = await db
    .select({
      item_id: items.item_id,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
      item_state: items.item_state,
      item_private_state: items.item_private_state,
      created_at: items.created_at,
      updated_at: items.updated_at,
    })
    .from(items)
    .where(
      networks.length > 0
        ? and(eq(items.created_by, user_id), inArray(items.item_network, networks))
        : eq(items.created_by, user_id),
    )
    .orderBy(items.created_at);
  return rows.map((r) => {
    const { item_private_state: _drop, ...rest } = r;
    const { mergedState } = decryptItemPrivate({
      item_state: r.item_state as Record<string, unknown>,
      item_private_state: r.item_private_state,
    });
    return {
      ...rest,
      item_state: mergedState,
      created_at: (r.created_at as Date).toISOString(),
      updated_at: (r.updated_at as Date).toISOString(),
    };
  });
}

export default participant;
