import type {
  FastifyPluginAsync,
  FastifyReply,
  FastifyRequest,
} from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, or } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { ensureItemPartition, items } from '@dpg/database';
import { user } from '../../../../db/postgres/schema/auth.js';
import { authInstance } from '@/routes/auth/create_auth';
import { create_profile_item } from '@/lib/profile_item';
import { updateItemInternal, type DbOrTx } from '@/services/item_service';
import { apiConfig, authConfig } from '@/config';
import { publishItemEvent } from '@/utils/publish_item_event';
import {
  UpsertParticipantRequest,
  UpsertParticipantResponse,
  type UpsertParticipantRequest as UpsertBody,
} from '@dpg/schemas';
import { decryptItemPrivate } from '@/utils/item_decrypt';
import { resolve_upsert_action } from './_resolve_upsert_action.js';
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
  age: number | undefined;
  acting_org_id: string;
  channel: UpsertBody['channel'];
  source_id: string | undefined;
  now: Date;
};

const buildOnboardingSet = (f: OnboardingFields) => ({
  phoneNumber: f.phone_norm,
  phoneNumberVerified: false,
  // Age snapshot (#331) — integrating DPGs derive it from the birth year and
  // send the number; no birth date is accepted. (Deprecated terms/privacy
  // booleans are intentionally NOT written — consent lives in the ledger, #309.)
  age: f.age ?? null,
  onboardedByOrgId: f.acting_org_id,
  onboardedVia: f.channel,
  onboardedSourceId: f.source_id ?? null,
  onboardedAt: f.now,
  updatedAt: f.now,
});

// ---------------------------------------------------------------------------
// signUpAndOnboardUser
//
// Creates the participant's local `user` row, applies the onboarding columns,
// runs whatever else the caller needs in the same transaction, and finally mints
// the Keycloak identity.
//
// Two ways the row gets created, chosen by AUTH_PROVIDER:
//
//   keycloak    `insertLocalUser` writes it directly, INSIDE the transaction that
//               also carries the onboarding columns and the caller's work. So a
//               failure anywhere rolls the whole thing back and there is no
//               orphan to clean up.
//   betterauth  `signUpEmail` writes it first and outside any transaction (that
//               is better-auth's own API), so the row is already committed when
//               the transaction starts — and an orphan IS possible, hence the
//               compensating delete below.
//
// Used by two branches: `account_only` (no item) and `create_new_user` (which
// also creates the profile item). Both supply `withinTx`; neither owns a
// transaction any more, because the user write has to be able to join it.
//
// Returns { ok: true, user_id } or a typed failure the caller turns into a reply.
// ---------------------------------------------------------------------------

type SignUpResult =
  | { ok: true; user_id: string }
  | { ok: false; statusCode: number; error: string; message: string };

/** Shape both branches share for classifying a write failure. */
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

async function signUpAndOnboardUser(params: {
  /**
   * The participant's real email, or null for a phone-only participant.
   *
   * Deliberately not a synthesised address. `signUpEmail` requires one, so the
   * `<uuid>@no-email.local` placeholder is derived below and confined to that
   * branch — it used to be computed by the callers and then leaked into both the
   * `user` row and the Keycloak identity.
   */
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
  const keycloak = authConfig.keycloak_enabled;

  // Under Keycloak signals owns the id, and it must be a bare UUID because it
  // becomes the Keycloak `sub` (enforced by insertLocalUser).
  let user_id: string = randomUUID();
  /** Only ever true on the better-auth path — see the header note. */
  let rowCommittedOutsideTx = false;

  if (!keycloak) {
    const email_for_signup = email_norm ?? `${randomUUID()}@no-email.local`;
    try {
      const signed_up = await authInstance.api.signUpEmail({
        body: {
          email: email_for_signup,
          password: randomUUID(),
          name,
        },
      });
      user_id = signed_up.user.id;
      rowCommittedOutsideTx = true;
    } catch (signupErr: unknown) {
      if (isUniqueViolation(signupErr)) {
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
  }

  try {
    await db.transaction(async (tx) => {
      if (keycloak) {
        // The row and its onboarding columns in one insert — there is no
        // separate update to sequence, and nothing to orphan if the rest of the
        // transaction fails. Consent booleans are deliberately not written here;
        // consent lives in the ledger (#309), which `withinTx` records.
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
      } else {
        await tx.update(user).set(buildOnboardingSet(fields)).where(eq(user.id, user_id));
      }

      await withinTx(tx, user_id);
    });
  } catch (updateErr: unknown) {
    // Orphan cleanup, better-auth path only. Under Keycloak the row was written
    // inside the transaction that just rolled back, so deleting here would at
    // best be a no-op and at worst remove a *different* row that happened to
    // reuse the id.
    if (rowCommittedOutsideTx) {
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
    }

    const e = updateErr as {
      code?: string;
      message?: string;
      cause?: { code?: string };
      statusCode?: number;
      errorCode?: string;
    } | null;

    // Propagate typed service errors (e.g. from create_profile_item, or the
    // insert failure re-thrown above).
    if (e?.statusCode && e?.errorCode) {
      return {
        ok: false,
        statusCode: e.statusCode,
        error: e.errorCode,
        message: e.message ?? 'request rejected',
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

  // The realm identity comes last, once the local row is complete: under
  // Keycloak the `user` row is only a mirror, and without a realm user the OTP
  // login fails with `user_not_found` — the participant would be onboarded and
  // permanently unable to sign in. Deliberately fails the whole request rather
  // than logging and continuing; the orphan is cleaned up the same way an
  // update failure is, so the caller can safely retry.
  const identity = await createParticipantKeycloakIdentity({
    userId: user_id,
    name,
    // The real email, or null. Passing the `@no-email.local` placeholder here is
    // what made the realm identity's username an address nobody can receive mail
    // at — their phone is then the only usable channel, and the fake address
    // matches no lookup on either side.
    email: email_norm,
    phoneNumber: fields.phone_norm,
    log,
  });

  if (!identity.ok) {
    try {
      await db.delete(user).where(eq(user.id, user_id));
      log.warn(
        { orphan_user_id: user_id, identity_error: identity.code },
        'cleaned up orphan user after the Keycloak identity could not be created',
      );
    } catch (cleanupErr) {
      log.error(
        { cleanupErr, orphan_user_id: user_id },
        'failed to clean up orphan user — manual cleanup needed',
      );
    }

    return {
      ok: false,
      statusCode: identity.code === 'IDENTITY_CONFLICT' ? 409 : 500,
      error: identity.code,
      message: identity.message,
    };
  }

  return { ok: true, user_id };
}

export const participant_handler = async (
  request: UpsertRequest,
  reply: FastifyReply,
) => {
  const body = request.body;
  let consent_recorded = 0;
  const email_norm = body.email?.trim().toLowerCase() ?? null;
  const phone_norm = body.phone_number?.trim() ?? null;

  // Defensive — schema refine should have caught this.
  if (!email_norm && !phone_norm) {
    return reply.code(400).send({
      error: 'MISSING_IDENTIFIER',
      message: 'either email or phone_number is required',
    });
  }

  // --- Consent-payload validation (#309) ---
  const compliance = body.compliance ?? [];
  // Accept-only: any entry sent as false rejects the whole request.
  if (compliance.some((c) => c.value === false)) {
    return reply.code(400).send({
      error: 'CONSENT_DECLINED',
      message: 'consent cannot be declined — omit a key to skip it',
    });
  }
  // user_terms + user_privacy are a both-or-none pair.
  const hasUserTerms = compliance.some((c) => c.key === 'user_terms' && c.value === true);
  const hasUserPrivacy = compliance.some((c) => c.key === 'user_privacy' && c.value === true);
  if (hasUserTerms !== hasUserPrivacy) {
    return reply.code(400).send({
      error: 'USER_LEVEL_INCOMPLETE',
      message: 'user_terms and user_privacy must be sent together',
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
      age: user.age,
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

  // 3. Dispatch. A create is always an insert (#349): item_state with no
  //    item_id creates a NEW profile every call; item_id updates that specific
  //    item. The per-user profile cap is enforced downstream in
  //    createItemInternal (createProfileItem), so all creation paths share it.
  const verdict = resolve_upsert_action({
    acting_org: request.acting_org,
    user_exists,
    item_id_in_body: body.item_id,
    has_item_state,
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

  // Age gates run ONLY after the ownership verdict, and only on branches that
  // actually act on the user (owned aggregator / network_service / new-user
  // onboarding). Evaluating them earlier — on the globally-matched user, before
  // the aggregator_owned_elsewhere gate above — would let a non-owning aggregator
  // probe another tenant's user: U18_NOT_ALLOWED would leak minor-status and
  // AGE_REQUIRED would leak "no age on file". Placed here they still precede every
  // DB write (all writes live in the branches below), so a minor is still a true
  // no-op for legitimate onboarding.
  //
  // Effective age (#331): what this call supplies, else what's already on file.
  const effectiveAge = body.age ?? existing?.age ?? null;

  // U18 (#309/#331): a minor is NEVER onboarded via this server-to-server API.
  // Reject with an error and perform NO operation — no create/update, no consent.
  // Minors complete onboarding through the portal (guardian OTP flow).
  if (effectiveAge != null && isMinor(effectiveAge)) {
    return reply.code(400).send({
      error: 'U18_NOT_ALLOWED',
      message: 'under-18 users cannot be onboarded via this API; use the portal',
    });
  }

  // On guardian-gated domains, recording user consent requires a known age so we
  // can confirm the user is an adult before recording consent / promoting. An age
  // already on the user's record satisfies it; only a brand-new / age-less user
  // must supply one. Runs after the lookup so a returning adult re-sending the
  // consent pair isn't wrongly rejected.
  if (hasUserTerms && hasUserPrivacy && effectiveAge == null) {
    const gate_network = body.network ?? 'blue_dot';
    const gate_domain = body.domain ?? 'seeker';
    let gated = false;
    try {
      gated = guardianConsentRequired(await getNetworkConfigById(gate_network), gate_domain);
    } catch (err) {
      request.log.warn({ err, network: gate_network }, 'network config load failed during age gate check');
    }
    if (gated) {
      return reply.code(400).send({
        error: 'AGE_REQUIRED',
        message: 'age is required with consent on this domain',
      });
    }
  }

  if (verdict.kind === 'account_only') {
    if (!user_exists) {
      // New user — create account but skip item creation.
      const acting_org_id = request.acting_org!.org_id;
      const network = body.network ?? 'blue_dot';
      const now = new Date();

      const fields: OnboardingFields = {
        phone_norm,
        age: body.age,
        acting_org_id,
        channel: body.channel,
        source_id: body.source_id,
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
        consent_recorded,
      });
    }

    // Existing user, no item_state — persist age / record user-level consent,
    // then promote any drafts the new age unblocks.
    const hasCompliance = Boolean(body.compliance && body.compliance.length > 0);
    if (hasCompliance || body.age != null) {
      const network = body.network ?? 'blue_dot';
      try {
        await db.transaction(async (tx) => {
          if (body.age != null) {
            await tx
              .update(user)
              .set({ age: body.age, updatedAt: new Date() })
              .where(eq(user.id, existing!.id));
          }
          if (hasCompliance) {
            const consent = await recordParticipantConsent(tx, {
              compliance: body.compliance,
              userId: existing!.id,
              network,
              brand: null,
              channel: body.channel,
              acceptedAt: new Date(),
            });
            consent_recorded = consent.recorded;
          }
          if (body.age != null) {
            await promoteEligibleDraftsForUser(tx, existing!.id);
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

    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: false,
      onboarded_at: null,
      items: itemsList,
      consent_recorded,
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

    const hasItemState = Boolean(
      body.item_state && Object.keys(body.item_state).length > 0,
    );
    let updateResult:
      | {
          row: {
            item_network: string;
            item_domain: string;
            item_type: string;
            item_id: string;
          };
        }
      | undefined;
    try {
      await db.transaction(async (tx) => {
        if (hasItemState) {
          updateResult = await updateItemInternal(
            tx,
            verdict.item_id,
            existing!.id,
            true, // isAdmin — ownership already verified above
            { item_state: body.item_state ?? {} },
          );
        }
        if (body.age != null) {
          await tx
            .update(user)
            .set({ age: body.age, updatedAt: new Date() })
            .where(eq(user.id, existing!.id));
        }
        const consent = await recordParticipantConsent(tx, {
          compliance: body.compliance,
          userId: existing!.id,
          itemId: verdict.item_id,
          network: body.network ?? 'blue_dot',
          brand: null,
          channel: body.channel,
          acceptedAt: new Date(),
        });
        consent_recorded = consent.recorded;
        if (body.age != null) {
          await promoteEligibleDraftsForUser(tx, existing!.id);
        }
      });
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
        // DB error's message includes the failed SQL + bound params — never return it.
        message: e.errorCode ? (err as Error).message : 'item update failed',
      });
    }

    if (updateResult) {
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
    }

    const itemsList = await readItemsForUser(existing!.id);
    return reply.code(200).send({
      user_id: existing!.id,
      user_existed: true,
      owned_elsewhere: false,
      onboarded_at: null,
      items: itemsList,
      consent_recorded,
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
      // Must run inside a transaction: createItemInternal's profile-cap guard
      // takes a transaction-scoped advisory lock (pg_advisory_xact_lock) and
      // then counts+inserts — on the plain pooled `db` (autocommit) that lock
      // would release immediately, leaving the check→insert non-atomic and the
      // cap racy. The same transaction also makes the consent write + promotion
      // atomic with the item insert. Mirrors create_new_user + /item/create.
      await db.transaction(async (tx) => {
        // Persist age (#331) BEFORE recording consent so promoteItemOnProfileConsent
        // sees the adult age and can flip the new profile live. Adding a profile to
        // an existing user is this branch; without this write, an age supplied here
        // is dropped and the profile is stuck draft under the guardian gate (#309).
        if (body.age != null) {
          await tx
            .update(user)
            .set({ age: body.age, updatedAt: new Date() })
            .where(eq(user.id, existing!.id));
        }
        const { item_id } = await create_profile_item({
          tx,
          user_id: existing!.id,
          network,
          domain,
          item_type,
          payload: body.item_state ?? {},
        });
        insertedItemId = item_id;
        const consent = await recordParticipantConsent(tx, {
          compliance: body.compliance,
          userId: existing!.id,
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
          await promoteEligibleDraftsForUser(tx, existing!.id);
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
      consent_recorded,
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

  const fields: OnboardingFields = {
    phone_norm,
    age: body.age,
    acting_org_id,
    channel: body.channel,
    source_id: body.source_id,
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
    consent_recorded,
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
      lifecycle_status: items.lifecycle_status,
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
