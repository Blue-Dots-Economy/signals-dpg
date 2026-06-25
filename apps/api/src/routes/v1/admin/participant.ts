import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { ensureItemPartition, items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import { authInstance } from '@/routes/auth/create_auth';
import { create_profile_item } from '@/lib/profile_item';
import { updateItemInternal } from '@/services/item_service';
import { apiConfig } from '@/config';
import { publishItemEvent } from '@/utils/publish_item_event';
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
 * Tier-aware upsert. Dispatches on `resolve_upsert_action`'s verdict
 * (6 kinds) + a runtime ownership check for the update_item branch.
 *
 * When `item_state` is absent the route enters account_only mode:
 * - new user  → create user (no item), return user_existed:false
 * - existing user → return items, owned_elsewhere:false
 *
 * Aggregators that target a user they did not onboard receive
 * owned_elsewhere:true with an empty items list and no data disclosed.
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

// ---------------------------------------------------------------------------
// Shared onboarding-field payload builder (same columns in both branches).
// ---------------------------------------------------------------------------

type OnboardingFields = {
  phone_norm: string | null;
  date_of_birth: string | undefined;
  acting_org_id: string;
  channel: UpsertBody['channel'];
  source_id: string | undefined;
  now: Date;
};

const buildOnboardingSet = (f: OnboardingFields) => ({
  phoneNumber: f.phone_norm,
  phoneNumberVerified: false,
  dateOfBirth: f.date_of_birth ? new Date(f.date_of_birth) : null,
  termsAccepted: true,
  privacyAccepted: true,
  onboardedByOrgId: f.acting_org_id,
  onboardedVia: f.channel,
  onboardedSourceId: f.source_id ?? null,
  onboardedAt: f.now,
  updatedAt: f.now,
});

// ---------------------------------------------------------------------------
// signUpAndOnboardUser
//
// Handles the signUpEmail call (incl. 23505-race → 409 early exit) and
// the db.update for onboarding fields (incl. orphan cleanup on failure).
//
// Used by two branches:
//   - account_only new-user: plain update, no item step.
//   - create_new_user: update + create_profile_item wrapped in db.transaction.
//     For that branch, pass `updateExecutor` to run inside the same transaction.
//
// Returns:
//   { ok: true; user_id: string }   – success
//   { ok: false; reply: Response }  – caller must `return reply.code(...).send(...)`
//                                     (use the already-sent reply object)
//
// Rationale: the two callers share signUpEmail error handling verbatim (~30 lines)
// and the same onboarding columns. The only difference is the update executor
// (plain db.update vs a transactional tx.update + create_profile_item). Passing
// the executor as a callback keeps the distinction visible and avoids merging
// incompatible error shapes.
// ---------------------------------------------------------------------------

type SignUpResult =
  | { ok: true; user_id: string }
  | { ok: false; statusCode: number; error: string; message: string };

async function signUpAndOnboardUser(params: {
  email_for_signup: string;
  name: string;
  fields: OnboardingFields;
  log: FastifyRequest['log'];
  /**
   * Called with the new user_id to perform the DB update (and any extra
   * work). Must throw on failure. The outer function handles orphan cleanup.
   */
  updateExecutor: (user_id: string) => Promise<void>;
}): Promise<SignUpResult> {
  const { email_for_signup, name, fields, log, updateExecutor } = params;

  let user_id: string;
  try {
    const signed_up = await authInstance.api.signUpEmail({
      body: {
        email: email_for_signup,
        password: randomUUID(),
        name,
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
      log.warn({ err: signupErr }, 'signUp race; user exists now');
      return {
        ok: false,
        statusCode: 409,
        error: 'USER_ALREADY_EXISTS',
        message: 'email or phone already in use (race) — retry the request',
      };
    }
    log.error({ err: signupErr }, 'signUp failed during onboarding');
    return {
      ok: false,
      statusCode: 500,
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    };
  }

  try {
    await updateExecutor(user_id);
  } catch (updateErr: unknown) {
    // Orphan cleanup — best effort.
    try {
      await db.delete(user).where(eq(user.id, user_id));
      log.warn(
        { orphan_user_id: user_id },
        'cleaned up orphan user after update/tx failed',
      );
    } catch (cleanupErr) {
      log.error(
        { cleanupErr, orphan_user_id: user_id },
        'failed to clean up orphan user — manual cleanup needed',
      );
    }

    const e = updateErr as {
      code?: string;
      message?: string;
      cause?: { code?: string };
      statusCode?: number;
      errorCode?: string;
    } | null;

    // Propagate typed service errors (e.g. from create_profile_item).
    if (e?.statusCode && e?.errorCode) {
      return {
        ok: false,
        statusCode: e.statusCode,
        error: e.errorCode,
        message: e.message ?? 'request rejected',
      };
    }

    const pg_code = e?.code ?? e?.cause?.code;
    const msg = String(e?.message ?? '');
    if (
      pg_code === '23505' ||
      msg.includes('duplicate key value') ||
      msg.includes('unique constraint')
    ) {
      return {
        ok: false,
        statusCode: 409,
        error: 'USER_ALREADY_EXISTS',
        message: 'email or phone already in use (race)',
      };
    }

    log.error({ err: updateErr }, 'participant onboard failed');
    return {
      ok: false,
      statusCode: 500,
      error: 'ONBOARD_FAILED',
      message: 'could not onboard participant',
    };
  }

  return { ok: true, user_id };
}

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

  // 2. Compute aggregator ownership and dispatch on the helper's verdict.
  const aggregator_owns_user = Boolean(
    request.acting_org &&
    request.acting_org.org_type === 'aggregator' &&
    existing &&
    existing.onboardedByOrgId === request.acting_org.org_id,
  );

  const has_item_state = Boolean(
    body.item_state && Object.keys(body.item_state).length > 0,
  );

  // 3. Idempotent dedup lookup: when the user already exists, the caller
  //    supplies item_state but NO item_id, and this org is allowed to write
  //    (i.e. not aggregator_owned_elsewhere), look for an existing item of
  //    the exact (item_network, item_domain, item_type) owned by this user.
  //    If found, the resolver routes to update_item instead of insert_item,
  //    making repeated onboard calls idempotent.
  //
  //    The lookup is skipped entirely when:
  //      - user does not exist (no item can exist yet)
  //      - body.item_id is set (caller already targeted a specific item)
  //      - has_item_state is false (account_only path — no item write at all)
  //      - aggregator and does NOT own the user (aggregator_owned_elsewhere
  //        path — we must not leak the item_id to a foreign aggregator)
  //
  //    Partition pruning: filtering on item_network, item_domain, item_type
  //    AND created_by lets the Postgres planner prune to the correct child
  //    partition before scanning.
  let existing_owned_item_id: string | undefined;
  if (
    user_exists &&
    has_item_state &&
    !body.item_id &&
    !(request.acting_org?.org_type === 'aggregator' && !aggregator_owns_user)
  ) {
    const network = body.network ?? 'blue_dot';
    const domain = body.domain ?? 'seeker';
    const item_type = body.item_type ?? 'profile_1.0';
    const existing_rows = await db
      .select({ item_id: items.item_id })
      .from(items)
      .where(
        and(
          eq(items.created_by, existing!.id),
          eq(items.item_network, network),
          eq(items.item_domain, domain),
          eq(items.item_type, item_type),
        ),
      )
      .orderBy(desc(items.updated_at))
      .limit(1);
    existing_owned_item_id = existing_rows[0]?.item_id;
  }

  const verdict = resolve_upsert_action({
    acting_org: request.acting_org,
    user_exists,
    item_id_in_body: body.item_id,
    has_item_state,
    aggregator_owns_user,
    existing_owned_item_id,
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

  if (verdict.kind === 'aggregator_owned_elsewhere') {
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: true,
      onboarded_at: null,
      items: [],
    });
  }

  if (verdict.kind === 'account_only') {
    if (!user_exists) {
      // New user — create account but skip item creation.
      const acting_org_id = request.acting_org!.org_id;
      const now = new Date();
      const email_for_signup = email_norm ?? `${randomUUID()}@no-email.local`;

      const fields: OnboardingFields = {
        phone_norm,
        date_of_birth: body.date_of_birth,
        acting_org_id,
        channel: body.channel,
        source_id: body.source_id,
        now,
      };

      const result = await signUpAndOnboardUser({
        email_for_signup,
        name: body.name,
        fields,
        log: request.log,
        updateExecutor: async (user_id) => {
          await db
            .update(user)
            .set(buildOnboardingSet(fields))
            .where(eq(user.id, user_id));
        },
      });

      if (!result.ok) {
        return reply.code(result.statusCode).send({
          error: result.error,
          message: result.message,
        });
      }

      return reply.code(200).send({
        user_id: result.user_id,
        user_existed: false,
        owned_elsewhere: false,
        onboarded_at: now.toISOString(),
        items: [],
      });
    }

    // Existing user, no item_state — read and return their items.
    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: false,
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

    let updateResult: { row: { item_network: string; item_domain: string; item_type: string; item_id: string } } | undefined;
    try {
      updateResult = await updateItemInternal(
        db,
        verdict.item_id,
        existing!.id,
        true, // isAdmin — ownership already verified above
        { item_state: body.item_state ?? {} },
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
        // Only surface a curated ItemServiceError message (errorCode set). A raw
        // DB error's message includes the failed SQL + bound params — i.e. the
        // participant's item_state (name/phone/email) — so never return it.
        message: e.errorCode ? (err as Error).message : 'item update failed',
      });
    }

    await publishItemEvent(
      {
        item_network: updateResult.row.item_network,
        item_domain: updateResult.row.item_domain,
        item_type: updateResult.row.item_type,
        item_id: updateResult.row.item_id,
        op: 'upsert',
      },
      request.log,
    );

    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: false,
      onboarded_at: null,
      items: itemsList,
    });
  }

  if (verdict.kind === 'insert_item') {
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
    let insertedItemId: string | undefined;
    try {
      const { item_id } = await create_profile_item({
        tx: db,
        user_id: existing!.id,
        network,
        domain,
        item_type,
        payload: body.item_state ?? {},
      });
      insertedItemId = item_id;
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
        // Only surface a curated ItemServiceError message (errorCode set). A raw
        // DB error's message includes the failed SQL + bound params — i.e. the
        // participant's item_state (name/phone/email) — so never return it.
        message: e.errorCode ? (err as Error).message : 'item insert failed',
      });
    }

    await publishItemEvent(
      { item_network: network, item_domain: domain, item_type, item_id: insertedItemId!, op: 'upsert' },
      request.log,
    );

    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: false,
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

  const fields: OnboardingFields = {
    phone_norm,
    date_of_birth: body.date_of_birth,
    acting_org_id,
    channel: body.channel,
    source_id: body.source_id,
    now,
  };

  let onboarded_item_id: string | undefined;
  const result = await signUpAndOnboardUser({
    email_for_signup,
    name: body.name,
    fields,
    log: request.log,
    updateExecutor: async (user_id) => {
      await db.transaction(async (tx) => {
        await tx
          .update(user)
          .set(buildOnboardingSet(fields))
          .where(eq(user.id, user_id));

        const { item_id } = await create_profile_item({
          tx,
          user_id,
          network,
          domain,
          item_type,
          payload: body.item_state ?? {},
        });
        onboarded_item_id = item_id;
      });
    },
  });

  if (!result.ok) {
    return reply.code(result.statusCode).send({
      error: result.error,
      message: result.message,
    });
  }

  if (onboarded_item_id) {
    await publishItemEvent(
      { item_network: network, item_domain: domain, item_type, item_id: onboarded_item_id, op: 'upsert' },
      request.log,
    );
  }

  const itemsList = await readItemsForUser(result.user_id);
  return reply.code(200).send({
    user_id: result.user_id,
    user_existed: false,
    owned_elsewhere: false,
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
      item_locations: items.item_locations,
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
