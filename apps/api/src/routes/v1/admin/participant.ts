import type {
  FastifyPluginCallback,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { ensureItemPartition, items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import { create_profile_item } from '@/lib/profile_item';
import { resolveDefaultAggregator } from '@/services/aggregator/default_aggregator';
import { updateItemInternal, type DbOrTx } from '@/services/item_service';
import {
  publishItemEvent,
  publishItemEvents,
  type ItemEventKey,
} from '@/utils/publish_item_event';
import {
  UpsertParticipantRequest,
  UpsertParticipantResponse,
  type UpsertParticipantRequest as UpsertBody,
} from '@dpg/schemas';
import { resolve_upsert_action } from './_resolve_upsert_action.js';
import { readItemsForUser } from './_participant_items.js';
import {
  recordParticipantConsent,
  promoteEligibleDraftsForUser,
} from '@/services/participant_consent';
import { getNetworkConfigById } from '@/network_configs';
import { guardianConsentRequired, isMinor } from '@/services/minor';
import { createParticipantKeycloakIdentity } from '@/services/auth/participant_identity';
import { insertLocalUser } from '@/services/auth/user_writer';

/**
 * POST /api/v1/admin/participant
 *
 * Tier-aware upsert. Dispatches on `resolve_upsert_action`'s verdict, plus a
 * runtime ownership check for the update_item branch.
 *
 * When `item_state` is absent the route enters account_only mode:
 * - new user  → create user (no item), return user_existed:false
 * - existing user → return items, owned_elsewhere:false
 *
 * Aggregators that target a user they did not onboard receive
 * owned_elsewhere:true with an empty items list and no data disclosed.
 */
type UpsertRequest = FastifyRequest<{ Body: UpsertBody }>;

// Callback-style: registering a route is synchronous, so there is nothing to
// await (an async plugin with no await is Sonar S7503).
export const participant: FastifyPluginCallback = (app, _opts, done) => {
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
  done();
};

type OnboardingFields = {
  phone_norm: string | null;
  age: number | undefined;
  /**
   * The aggregator that owns this participant, or null when nobody does yet.
   * Not always the acting org: a `network_service` caller resolves the
   * instance's default aggregator instead (see `resolveOnboardingOwnerOrg`).
   */
  owner_org_id: string | null;
  /** True when `owner_org_id` came from the default rather than a real onboarding act. */
  onboarded_by_default: boolean;
  channel: UpsertBody['channel'];
  source_id: string | undefined;
  /**
   * The domain this participant is being onboarded into, when the caller named
   * one. Recorded on `user.domains` so the single-domain lock has something to
   * lock against.
   *
   * Undefined for an aggregator caller that omits `domain` on the account-only
   * path; the column then stays empty and the participant's first item create
   * records it (`claimDomain`).
   */
  domain: string | undefined;
  now: Date;
};

/** A non-aggregator caller omitted `domain`, so no default can be resolved. */
export const DOMAIN_REQUIRED_FOR_DEFAULT = {
  error: 'DOMAIN_REQUIRED' as const,
  message:
    'domain is required when acting on behalf of a non-aggregator org: it selects which default aggregator owns the participant',
};

/**
 * Who owns a participant created through this route.
 *
 * An aggregator caller owns the participants it onboards. A `network_service`
 * caller (e.g. the network-hosted voice agent) is not an aggregator, so the
 * participant falls back to the default aggregator nominated for the
 * (network, domain) binding, or stays untagged when none is nominated.
 *
 * `domain` is required on that branch even though the request schema defaults
 * it to `'seeker'`: defaults are per (network, domain), so a silent `'seeker'`
 * fallback would hand a provider participant, and the right to decrypt their
 * PII, to the seeker aggregator.
 *
 * Works in `account_only` mode too, since `domain` is a top-level body field.
 *
 * @returns the resolved owner, or `null` when the caller omitted `domain`
 *   (the caller turns that into a 400).
 */
async function resolveOnboardingOwnerOrg(
  exec: DbOrTx,
  acting: { org_id: string; org_type: 'aggregator' | 'network_service' },
  network: string,
  domain: string | undefined,
  log: FastifyRequest['log'],
): Promise<{ owner_org_id: string | null; onboarded_by_default: boolean } | null> {
  if (acting.org_type === 'aggregator') {
    return { owner_org_id: acting.org_id, onboarded_by_default: false };
  }

  if (!domain) return null;

  const { org_id } = await resolveDefaultAggregator(exec, network, domain);
  if (!org_id) {
    log.info(
      { acting_org_id: acting.org_id, org_type: acting.org_type, network, domain },
      'participant: no default aggregator nominated for this binding — participant left untagged',
    );
    return { owner_org_id: null, onboarded_by_default: false };
  }
  return { owner_org_id: org_id, onboarded_by_default: true };
}

const buildOnboardingSet = (f: OnboardingFields) => ({
  phoneNumber: f.phone_norm,
  phoneNumberVerified: false,
  // Age snapshot: integrating DPGs derive it from the birth year; no birth date
  // is accepted. Consent booleans are not written here; consent lives in the
  // ledger.
  age: f.age ?? null,
  onboardedByOrgId: f.owner_org_id,
  onboardedByDefault: f.onboarded_by_default,
  onboardedVia: f.channel,
  onboardedSourceId: f.source_id ?? null,
  onboardedAt: f.now,
  updatedAt: f.now,
  // Only when the caller named a domain — never write an empty array, which
  // would read as "locked to nothing" rather than "not yet decided".
  ...(f.domain ? { domains: [f.domain] } : {}),
});

type SignUpResult =
  | { ok: true; user_id: string }
  | {
      ok: false;
      statusCode: number;
      error: string;
      message: string;
      /**
       * A typed client error's curated extras (e.g. INVALID_ITEM_STATE's
       * per-field `fields`), merged into the error body — the same body the
       * existing-user branches return via replyItemWriteFailure.
       */
      details?: Record<string, unknown>;
    };

/** Postgres unique violation (23505), by code or message. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string }; message?: string } | null;
  const pg_code = e?.code ?? e?.cause?.code;
  const message = String(e?.message ?? '');
  return (
    pg_code === '23505' ||
    message.includes('duplicate key value') ||
    message.includes('unique constraint')
  );
}

/**
 * Creates the participant's local `user` row with its onboarding columns, runs
 * the caller's `withinTx` work in the same transaction, then mints the Keycloak
 * identity. A failure inside the transaction rolls everything back, so there is
 * no orphan row to clean up. Used by `account_only` (new user) and
 * `create_new_user`.
 */
async function signUpAndOnboardUser(params: {
  /** The participant's real email, or null for a phone-only participant. Never a synthesised address. */
  email_norm: string | null;
  name: string;
  fields: OnboardingFields;
  log: FastifyRequest['log'];
  /**
   * Caller-specific work — consent, and the profile item for `create_new_user`.
   * Runs inside the transaction that carries the onboarding columns. Must throw
   * on failure.
   */
  withinTx: (tx: DbOrTx, user_id: string) => Promise<void>;
}): Promise<SignUpResult> {
  const { email_norm, name, fields, log, withinTx } = params;

  // Signals owns the id, and it must be a bare UUID because it becomes the
  // Keycloak `sub` (enforced by insertLocalUser).
  const user_id: string = randomUUID();

  try {
    await db.transaction(async (tx) => {
      // The row and its onboarding columns in one insert. Consent is recorded
      // in the ledger by `withinTx`, not as user columns.
      const written = await insertLocalUser(
        {
          id: user_id,
          name,
          email: email_norm,
          // Onboarding by an aggregator proves nothing about the identifier;
          // the OTP login is what verifies it.
          emailVerified: false,
          phoneNumber: fields.phone_norm,
          phoneNumberVerified: false,
          extra: buildOnboardingSet(fields),
        },
        log,
        tx
      );

      if (!written.ok) {
        // Thrown so the transaction rolls back; classified by the catch below.
        throw Object.assign(new Error(written.message), {
          statusCode: written.code === 'IDENTITY_CONFLICT' ? 409 : 500,
          errorCode:
            written.code === 'IDENTITY_CONFLICT' ? 'USER_ALREADY_EXISTS' : 'ONBOARD_FAILED',
        });
      }

      await withinTx(tx, user_id);
    });
  } catch (updateErr: unknown) {
    // No orphan cleanup here: the row was written inside the transaction that
    // just rolled back, so a delete could only be a no-op or remove a different
    // row that reused the id.
    return classifyOnboardFailure(updateErr, log);
  }

  // The realm identity comes last, once the local row is committed. Without a
  // realm user the participant could never sign in, so a failure here fails the
  // whole request: the committed local row is deleted so the caller can retry.
  const identity = await createParticipantKeycloakIdentity({
    userId: user_id,
    name,
    // The real email or null, never a placeholder: a fake address would become
    // the realm username and match no lookup on either side.
    email: email_norm,
    phoneNumber: fields.phone_norm,
    log,
  });

  if (!identity.ok) {
    await deleteOrphanUser(
      user_id,
      log,
      { identity_error: identity.code },
      'cleaned up orphan user after the Keycloak identity could not be created',
    );

    return {
      ok: false,
      statusCode: identity.code === 'IDENTITY_CONFLICT' ? 409 : 500,
      error: identity.code,
      message: identity.message,
    };
  }

  return { ok: true, user_id };
}

/** Best-effort orphan removal; a failed delete is logged for manual cleanup. */
async function deleteOrphanUser(
  user_id: string,
  log: FastifyRequest['log'],
  warnFields: Record<string, unknown>,
  warnMessage: string,
): Promise<void> {
  try {
    await db.delete(user).where(eq(user.id, user_id));
    log.warn({ orphan_user_id: user_id, ...warnFields }, warnMessage);
  } catch (cleanupErr) {
    log.error(
      { cleanupErr, orphan_user_id: user_id },
      'failed to clean up orphan user — manual cleanup needed',
    );
  }
}

/** Turns a transaction/update failure into the route's typed failure shape. */
function classifyOnboardFailure(
  updateErr: unknown,
  log: FastifyRequest['log'],
): Extract<SignUpResult, { ok: false }> {
  const e = updateErr as {
    code?: string;
    message?: string;
    cause?: { code?: string };
    statusCode?: number;
    errorCode?: string;
    details?: Record<string, unknown>;
  } | null;

  // Propagate typed service errors (e.g. from create_profile_item, or the
  // insert failure re-thrown above). A client error keeps its curated details
  // (INVALID_ITEM_STATE's `fields`), so a new participant's rejection carries
  // the same body as an existing participant's.
  if (e?.statusCode && e?.errorCode) {
    const isClientError = e.statusCode >= 400 && e.statusCode < 500;
    return {
      ok: false,
      statusCode: e.statusCode,
      error: e.errorCode,
      message: e.message ?? 'request rejected',
      ...(isClientError && e.details ? { details: e.details } : {}),
    };
  }

  if (isUniqueViolation(updateErr)) {
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

/** The matched `user` row, as selected by {@link findExistingUser}. */
type ExistingUser = {
  id: string;
  email: string | null;
  phoneNumber: string | null;
  onboardedByOrgId: string | null;
  age: number | null;
};

/** Everything the verdict branches below share; resolved once by the handler. */
type ParticipantCtx = {
  request: UpsertRequest;
  reply: FastifyReply;
  body: UpsertBody;
  email_norm: string | null;
  phone_norm: string | null;
};

/** A rejected request: exactly the reply the caller must send. */
type ParticipantFailure = { status: number; error: string; message: string };

const failureReply = (reply: FastifyReply, f: ParticipantFailure) =>
  reply.code(f.status).send({ error: f.error, message: f.message });

/** `user_terms` / `user_privacy` acceptance, read off the compliance array. */
function userLevelPair(body: UpsertBody) {
  const compliance = body.compliance ?? [];
  const terms = compliance.some((c) => c.key === 'user_terms' && c.value === true);
  const privacy = compliance.some((c) => c.key === 'user_privacy' && c.value === true);
  return { terms, privacy };
}

/** Identifier presence + consent-payload validation. Null = acceptable. */
function validateParticipantPayload(
  body: UpsertBody,
  email_norm: string | null,
  phone_norm: string | null,
): ParticipantFailure | null {
  // Defensive — schema refine should have caught this.
  if (!email_norm && !phone_norm) {
    return {
      status: 400,
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    };
  }
  // Accept-only: any entry sent as false rejects the whole request.
  if ((body.compliance ?? []).some((c) => c.value === false)) {
    return {
      status: 400,
      error: 'CONSENT_DECLINED',
      message: 'consent cannot be declined — omit a key to skip it',
    };
  }
  // user_terms + user_privacy are a both-or-none pair.
  const { terms, privacy } = userLevelPair(body);
  if (terms !== privacy) {
    return {
      status: 400,
      error: 'USER_LEVEL_INCOMPLETE',
      message: 'user_terms and user_privacy must be sent together',
    };
  }
  return null;
}

/** Resolve the participant by either identifier. */
async function findExistingUser(
  email_norm: string | null,
  phone_norm: string | null,
): Promise<ExistingUser | null> {
  const conditions = [];
  if (email_norm) conditions.push(eq(user.email, email_norm));
  if (phone_norm) conditions.push(eq(user.phoneNumber, phone_norm));
  const whereClause =
    conditions.length === 1 ? conditions[0] : or(...conditions);

  const rows = await db
    .select({
      id: user.id,
      email: user.email,
      phoneNumber: user.phoneNumber,
      onboardedByOrgId: user.onboardedByOrgId,
      age: user.age,
    })
    .from(user)
    .where(whereClause!)
    .limit(1);

  return rows[0] ?? null;
}

/**
 * The two age gates. They run only after the ownership verdict, on branches that
 * act on the user: evaluated earlier, a non-owning aggregator could probe another
 * tenant's user (`U18_NOT_ALLOWED` leaks minor status, `AGE_REQUIRED` leaks "no
 * age on file"). They still precede every DB write, so a minor is a true no-op.
 */
async function checkAgeGates(
  ctx: ParticipantCtx,
  effectiveAge: number | null,
): Promise<ParticipantFailure | null> {
  const { body, request } = ctx;

  // A minor is never onboarded via this server-to-server API; no create, update
  // or consent happens. Minors onboard through the portal (guardian OTP flow).
  if (effectiveAge != null && isMinor(effectiveAge)) {
    return {
      status: 400,
      error: 'U18_NOT_ALLOWED',
      message: 'under-18 users cannot be onboarded via this API; use the portal',
    };
  }

  // On guardian-gated domains, recording user consent requires a known age to
  // confirm the user is an adult. An age already on file satisfies it, so a
  // returning adult re-sending the consent pair is not rejected.
  const { terms, privacy } = userLevelPair(body);
  if (terms && privacy && effectiveAge == null) {
    const gate_network = body.network ?? 'blue_dot';
    const gate_domain = body.domain ?? 'seeker';
    let gated = false;
    try {
      gated = guardianConsentRequired(await getNetworkConfigById(gate_network), gate_domain);
    } catch (err) {
      request.log.warn({ err, network: gate_network }, 'network config load failed during age gate check');
    }
    if (gated) {
      return {
        status: 400,
        error: 'AGE_REQUIRED',
        message: 'age is required with consent on this domain',
      };
    }
  }

  return null;
}

/**
 * Failure mapping shared by the `update_item` and `insert_item` branches. A typed
 * service error (statusCode + errorCode) is a client error, logged at warn and
 * surfaced with its curated message; anything else is logged at error and answered
 * generically, because a raw DB error's text carries the failed SQL + bound params
 * — i.e. the participant's `item_state` (name/phone/email). Never return it.
 */
function replyItemWriteFailure(
  ctx: ParticipantCtx,
  err: unknown,
  opts: {
    logContext?: Record<string, unknown>;
    logMessage: string;
    fallbackError: string;
    fallbackMessage: string;
  },
) {
  const e = err as {
    statusCode?: number;
    errorCode?: string;
    details?: Record<string, unknown>;
  };
  const isClientError =
    typeof e.statusCode === 'number' && e.statusCode >= 400 && e.statusCode < 500;
  const logger = isClientError ? ctx.request.log.warn : ctx.request.log.error;
  logger.call(ctx.request.log, { err, ...opts.logContext }, opts.logMessage);
  return ctx.reply.code(e.statusCode ?? 500).send({
    // A typed client error's curated extras (e.g. INVALID_ITEM_STATE's per-field
    // `fields`) — never an untyped error's, whose shape is unknown. Spread first
    // so it cannot override the error code or message.
    ...(isClientError && e.errorCode ? e.details : undefined),
    error: e.errorCode ?? opts.fallbackError,
    message: e.errorCode ? (err as Error).message : opts.fallbackMessage,
  });
}

/** Partition setup, shared by the two item-creating branches. Null = ready. */
async function ensurePartitionOrFail(
  ctx: ParticipantCtx,
  network: string,
  domain: string,
): Promise<ParticipantFailure | null> {
  try {
    await ensureItemPartition(db, network, domain);
    return null;
  } catch (err) {
    ctx.request.log.error(
      { err, network, domain },
      'failed to ensure item partition',
    );
    return {
      status: 500,
      error: 'PARTITION_SETUP_FAILED',
      message: 'failed to prepare storage for item type',
    };
  }
}

/** The 200 shape every existing-user branch returns. */
async function existingUserOk(
  reply: FastifyReply,
  user_id: string,
  consent_recorded: number,
) {
  const itemsList = await readItemsForUser(user_id);
  return reply.code(200).send({
    user_id,
    user_existed: true,
    owned_elsewhere: false,
    onboarded_at: null,
    items: itemsList,
    consent_recorded,
  });
}

/**
 * Aggregator-onboarding initiation email, new users only. Both onboarding
 * channels (bulk + link) land on this route, so this is the single place the
 * "activate your account" email is sent. Welcome is never sent for these users:
 * their local row already exists, so provisioning.createMirror is skipped on
 * first login.
 * `actingOrgType: 'aggregator'` is hard-coded so a network_service onboard also
 * gets the initiation email (its copy then names an aggregator, which is
 * accepted).
 * Fire-and-forget, lazy-imported to keep the notification chain off this
 * route's static graph.
 */
function notifyAggregatorInit(
  ctx: ParticipantCtx,
  userId: string,
  network: string,
  domain: string,
): void {
  const orgId = ctx.request.acting_org?.org_id ?? null;
  void (async () => {
    const [{ dispatchItemLifecycleNotification }, { resolveOrgName }] = await Promise.all([
      import('@/notifications/notify_item_lifecycle'),
      import('@/notifications/resolve_owner'),
    ]);
    // Name the onboarding org in the email; fall back (dispatcher → network
    // brand) when it can't be resolved.
    const aggregatorOrgName = orgId ? await resolveOrgName(orgId) : null;
    await dispatchItemLifecycleNotification(
      { op: 'create', ownerId: userId, domain, network, actingOrgType: 'aggregator', aggregatorOrgName },
      ctx.request.log,
    );
  })().catch((err) => ctx.request.log.warn({ err }, 'aggregator-init notify failed'));
}

/** `account_only`, new user: create the account, skip item creation. */
async function handleAccountOnlyNewUser(ctx: ParticipantCtx) {
  const { request, reply, body, email_norm, phone_norm } = ctx;
  let consent_recorded = 0;
  const network = body.network ?? 'blue_dot';
  const now = new Date();

  // `body.domain`, not a `?? 'seeker'` fallback — see resolveOnboardingOwnerOrg.
  const owner = await resolveOnboardingOwnerOrg(
    db,
    request.acting_org!,
    network,
    body.domain,
    request.log,
  );
  if (!owner) return reply.code(400).send(DOMAIN_REQUIRED_FOR_DEFAULT);

  const fields: OnboardingFields = {
    phone_norm,
    age: body.age,
    owner_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
    channel: body.channel,
    source_id: body.source_id,
    domain: body.domain,
    now,
  };

  const result = await signUpAndOnboardUser({
    email_norm,
    name: body.name,
    fields,
    log: request.log,
    withinTx: async (tx, user_id) => {
      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: user_id,
        network,
        brand: null,
        channel: body.channel,
        acceptedAt: now,
      });
      consent_recorded = consent.recorded;
    },
  });

  if (!result.ok) {
    // `details` spread first so it can never override the error code or message.
    return reply.code(result.statusCode).send({
      ...result.details,
      error: result.error,
      message: result.message,
    });
  }

  notifyAggregatorInit(ctx, result.user_id, network, body.domain ?? 'seeker');

  return reply.code(200).send({
    user_id: result.user_id,
    user_existed: false,
    owned_elsewhere: false,
    onboarded_at: now.toISOString(),
    items: [],
    consent_recorded,
    onboarded_by_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
  });
}

/**
 * `account_only`, existing user: persist age / record user-level consent, then
 * publish the drafts the new age unblocks.
 */
async function handleAccountOnlyExistingUser(ctx: ParticipantCtx, existing: ExistingUser) {
  const { request, reply, body } = ctx;
  let consent_recorded = 0;
  // Drafts promoted as a side effect of the age write. Age is user-level, so it
  // can unblock several of the user's profiles at once.
  let promotedDrafts: ItemEventKey[] = [];

  const hasCompliance = Boolean(body.compliance && body.compliance.length > 0);
  if (hasCompliance || body.age != null) {
    const network = body.network ?? 'blue_dot';
    try {
      await db.transaction(async (tx) => {
        if (body.age != null) {
          await tx
            .update(user)
            .set({ age: body.age, updatedAt: new Date() })
            .where(eq(user.id, existing.id));
        }
        if (hasCompliance) {
          const consent = await recordParticipantConsent(tx, {
            compliance: body.compliance,
            userId: existing.id,
            network,
            brand: null,
            channel: body.channel,
            acceptedAt: new Date(),
          });
          consent_recorded = consent.recorded;
        }
        if (body.age != null) {
          promotedDrafts = await promoteEligibleDraftsForUser(tx, existing.id);
        }
      });
    } catch (err) {
      // Never surface the raw error message: a DB error's text can include the
      // failed SQL + bound params. Log the full error, return a curated code.
      request.log.error(
        { err },
        'participant existing-user consent/age update failed',
      );
      return reply.code(500).send({
        error: 'CONSENT_WRITE_FAILED',
        message: 'failed to record consent',
      });
    }
  }

  // Published after the transaction, never inside it: an event published
  // pre-commit lets the worker index the row before the promotion is visible.
  await publishItemEvents(promotedDrafts, 'upsert', request.log);

  return existingUserOk(reply, existing.id, consent_recorded);
}

/** `update_item`: update the named item, record consent, publish. */
async function handleUpdateItem(
  ctx: ParticipantCtx,
  existing: ExistingUser,
  item_id: string,
) {
  const { request, reply, body } = ctx;
  let consent_recorded = 0;
  let promotedDrafts: ItemEventKey[] = [];

  // Runtime ownership check, ahead of updateItemInternal so a mismatch is
  // 403 ITEM_NOT_OWNED_BY_USER rather than 404. The event key comes from the row,
  // not the body: body.network / domain / item_type are optional and need not
  // describe this item.
  const [ownerRow] = await db
    .select({
      created_by: items.created_by,
      item_network: items.item_network,
      item_domain: items.item_domain,
      item_type: items.item_type,
    })
    .from(items)
    .where(eq(items.item_id, item_id))
    .limit(1);
  if (ownerRow?.created_by !== existing.id) {
    return reply.code(403).send({
      error: 'ITEM_NOT_OWNED_BY_USER',
      message: 'item_id does not belong to the resolved user',
    });
  }
  const namedItem: ItemEventKey = {
    item_network: ownerRow.item_network,
    item_domain: ownerRow.item_domain,
    item_type: ownerRow.item_type,
    item_id,
  };

  const hasItemState = Boolean(
    body.item_state && Object.keys(body.item_state).length > 0,
  );
  // Coordinates the caller resolved itself. Empty is treated as absent, to
  // match `resolveLocationUpdate`, which only lets a NON-empty array win over
  // re-geocoding the address text.
  const hasItemLocations = Boolean(body.item_locations?.length);
  let itemWritten = false;
  let itemPromoted = false;
  try {
    await db.transaction(async (tx) => {
      // Coordinates alone are a valid update: a caller re-sending a profile's
      // exact point (e.g. the address was re-picked from an autocomplete) need
      // not re-send the whole item_state to have it stored.
      if (hasItemState || hasItemLocations) {
        await updateItemInternal(
          tx,
          item_id,
          existing.id,
          true, // isAdmin — ownership already verified above
          {
            ...(hasItemState ? { item_state: body.item_state } : {}),
            ...(hasItemLocations ? { item_locations: body.item_locations } : {}),
          },
        );
        itemWritten = true;
      }
      if (body.age != null) {
        await tx
          .update(user)
          .set({ age: body.age, updatedAt: new Date() })
          .where(eq(user.id, existing.id));
      }
      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: existing.id,
        itemId: item_id,
        network: body.network ?? 'blue_dot',
        brand: null,
        channel: body.channel,
        acceptedAt: new Date(),
      });
      consent_recorded = consent.recorded;
      // A consent-only activation sends no fields, and recordParticipantConsent
      // promotes the named item draft → live itself. Its `promoted` flag is the
      // only signal for that (promoteEligibleDraftsForUser no longer sees a
      // draft), and without it item_search would keep the profile as `draft`.
      itemPromoted = consent.promoted;
      if (body.age != null) {
        promotedDrafts = await promoteEligibleDraftsForUser(tx, existing.id);
      }
    });
  } catch (err) {
    return replyItemWriteFailure(ctx, err, {
      logContext: { item_id },
      logMessage: 'updateItemInternal failed',
      fallbackError: 'UPDATE_FAILED',
      fallbackMessage: 'item update failed',
    });
  }

  // The named item when it was written or promoted, plus any other draft the age
  // write promoted. publishItemEvents de-duplicates the overlap.
  await publishItemEvents(
    itemWritten || itemPromoted ? [namedItem, ...promotedDrafts] : promotedDrafts,
    'upsert',
    request.log,
  );

  return existingUserOk(reply, existing.id, consent_recorded);
}

/** `insert_item`: add another profile to an existing user. */
async function handleInsertItem(ctx: ParticipantCtx, existing: ExistingUser) {
  const { request, reply, body } = ctx;
  let consent_recorded = 0;
  let promotedDrafts: ItemEventKey[] = [];
  const network = body.network ?? 'blue_dot';
  const domain = body.domain ?? 'seeker';
  const item_type = body.item_type ?? 'profile_1.0';

  const partitionFailure = await ensurePartitionOrFail(ctx, network, domain);
  if (partitionFailure) return failureReply(reply, partitionFailure);

  let insertedItemId: string | undefined;
  try {
    // Must run inside a transaction: the profile-cap guard takes a
    // transaction-scoped advisory lock, which would release immediately under
    // autocommit and make the cap racy. It also makes the consent write and
    // promotion atomic with the insert.
    await db.transaction(async (tx) => {
      // Persist age before recording consent so promoteItemOnProfileConsent sees
      // the adult age and can flip the new profile live under the guardian gate.
      if (body.age != null) {
        await tx
          .update(user)
          .set({ age: body.age, updatedAt: new Date() })
          .where(eq(user.id, existing.id));
      }
      const { item_id } = await create_profile_item({
        tx,
        user_id: existing.id,
        network,
        domain,
        item_type,
        payload: body.item_state ?? {},
        item_locations: body.item_locations,
      });
      insertedItemId = item_id;
      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: existing.id,
        itemId: item_id,
        network,
        brand: null,
        channel: body.channel,
        acceptedAt: new Date(),
      });
      consent_recorded = consent.recorded;
      // A newly-known age can also unblock the user's other consented drafts
      // (age is user-level) — sweep them, mirroring the update_item branch.
      if (body.age != null) {
        promotedDrafts = await promoteEligibleDraftsForUser(tx, existing.id);
      }
    });
  } catch (err) {
    return replyItemWriteFailure(ctx, err, {
      logMessage: 'insert_item failed',
      fallbackError: 'INSERT_ITEM_FAILED',
      fallbackMessage: 'item insert failed',
    });
  }

  // The inserted item, plus any other draft the age write promoted.
  await publishItemEvents(
    [
      { item_network: network, item_domain: domain, item_type, item_id: insertedItemId! },
      ...promotedDrafts,
    ],
    'upsert',
    request.log,
  );

  return existingUserOk(reply, existing.id, consent_recorded);
}

/** `create_new_user`: onboard the account and its first profile together. */
async function handleCreateNewUser(ctx: ParticipantCtx) {
  const { request, reply, body, email_norm, phone_norm } = ctx;
  let consent_recorded = 0;
  const network = body.network ?? 'blue_dot';
  const domain = body.domain ?? 'seeker';
  const item_type = body.item_type ?? 'profile_1.0';

  const partitionFailure = await ensurePartitionOrFail(ctx, network, domain);
  if (partitionFailure) return failureReply(reply, partitionFailure);

  const now = new Date();

  const owner = await resolveOnboardingOwnerOrg(
    db,
    request.acting_org!,
    network,
    body.domain,
    request.log,
  );
  if (!owner) return reply.code(400).send(DOMAIN_REQUIRED_FOR_DEFAULT);

  const fields: OnboardingFields = {
    phone_norm,
    age: body.age,
    owner_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
    channel: body.channel,
    source_id: body.source_id,
    domain: body.domain,
    now,
  };

  let onboarded_item_id: string | undefined;
  const result = await signUpAndOnboardUser({
    email_norm,
    name: body.name,
    fields,
    log: request.log,
    withinTx: async (tx, user_id) => {
      const { item_id } = await create_profile_item({
        tx,
        user_id,
        network,
        domain,
        item_type,
        payload: body.item_state ?? {},
        item_locations: body.item_locations,
      });
      onboarded_item_id = item_id;

      const consent = await recordParticipantConsent(tx, {
        compliance: body.compliance,
        userId: user_id,
        itemId: item_id,
        network,
        brand: null,
        channel: body.channel,
        acceptedAt: now,
      });
      consent_recorded = consent.recorded;
    },
  });

  if (!result.ok) {
    // `details` spread first so it can never override the error code or message.
    return reply.code(result.statusCode).send({
      ...result.details,
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

  notifyAggregatorInit(ctx, result.user_id, network, domain);

  const itemsList = await readItemsForUser(result.user_id);
  return reply.code(200).send({
    user_id: result.user_id,
    user_existed: false,
    owned_elsewhere: false,
    onboarded_at: now.toISOString(),
    items: itemsList,
    consent_recorded,
    onboarded_by_org_id: owner.owner_org_id,
    onboarded_by_default: owner.onboarded_by_default,
  });
}

/**
 * Validate → resolve the participant → dispatch on the ownership verdict. The
 * order matters: payload validation, then ownership, then the age gates, then
 * any DB write.
 */
export const participant_handler = async (
  request: UpsertRequest,
  reply: FastifyReply,
) => {
  const body = request.body;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  const phone_norm = body.phone_number?.trim() ?? null;

  const payloadFailure = validateParticipantPayload(body, email_norm, phone_norm);
  if (payloadFailure) return failureReply(reply, payloadFailure);

  const ctx: ParticipantCtx = { request, reply, body, email_norm, phone_norm };

  const existing = await findExistingUser(email_norm, phone_norm);

  const aggregator_owns_user = Boolean(
    request.acting_org?.org_type === 'aggregator' &&
    existing?.onboardedByOrgId === request.acting_org?.org_id,
  );

  // A create is always an insert: item_state with no item_id creates a new
  // profile every call; item_id updates that item. The per-user profile cap is
  // enforced downstream in createItemInternal.
  const verdict = resolve_upsert_action({
    acting_org: request.acting_org,
    user_exists: Boolean(existing),
    item_id_in_body: body.item_id,
    has_item_state: Boolean(
      body.item_state && Object.keys(body.item_state).length > 0,
    ),
    aggregator_owns_user,
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

  if (verdict.kind === 'aggregator_owned_elsewhere') {
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: true,
      onboarded_at: null,
      items: [],
    });
  }

  // Effective age: what this call supplies, else what's already on file.
  const ageFailure = await checkAgeGates(ctx, body.age ?? existing?.age ?? null);
  if (ageFailure) return failureReply(reply, ageFailure);

  if (verdict.kind === 'account_only') {
    return existing
      ? handleAccountOnlyExistingUser(ctx, existing)
      : handleAccountOnlyNewUser(ctx);
  }

  if (verdict.kind === 'update_item') {
    return handleUpdateItem(ctx, existing!, verdict.item_id);
  }

  if (verdict.kind === 'insert_item') {
    return handleInsertItem(ctx, existing!);
  }

  return handleCreateNewUser(ctx);
};

export default participant;
