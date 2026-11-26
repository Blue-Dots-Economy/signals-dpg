import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';

export type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'network_service';
  service_user_id: string;
};

export type Audit = {
  performed_by_org_id: string | null;
  performed_by_service_user_id: string | null;
};

type ResolveOk = {
  ok: true;
  effective_user_id: string;
  audit: Audit;
};

export type ResolveErr = {
  ok: false;
  status: 400 | 403 | 404;
  error:
    | 'CANNOT_OVERRIDE_SELF'
    | 'MISSING_ACTING_AS_USER_ID'
    | 'ACTING_ORG_TYPE_NOT_ALLOWED'
    | 'NOT_AUTHORIZED_FOR_TARGET'
    | 'USER_NOT_FOUND';
};

export type ResolveActingActorResult = ResolveOk | ResolveErr;

export type ResolveActingActorInput = {
  acting_org: ActingOrg | undefined;
  request_user_id: string;
  acting_as_user_id: string | undefined;
  /**
   * Returns `{ onboardedByOrgId }` when the user row exists (with
   * `onboardedByOrgId` possibly null for self-registered or pre-Plan-2
   * users); returns `null` when no user row exists at all.
   *
   * The two states must be distinguished — aggregator-tier and
   * network-service-tier handle them differently.
   */
  lookup_user: (user_id: string) => Promise<{ onboardedByOrgId: string | null } | null>;
};

/**
 * Single source of truth for the action on-behalf-of authorization
 * matrix documented in
 * docs/superpowers/specs/2026-05-23-action-on-behalf-of-network-service-tier-design.md.
 *
 * Two tiers exist, and they are the only two:
 *   - `aggregator`: scoped to users with `onboarded_by_org_id ===
 *     acting_org.org_id`.
 *   - `network_service`: unrestricted; any user in the network.
 *
 * Every other org type is rejected. #518 retired a third, `voice`, which
 * reached exactly as far as `network_service` and so decided nothing; the
 * voice channel is now told apart by the token's `azp`, not by its org type.
 */
export const resolve_acting_actor = async (
  input: ResolveActingActorInput,
): Promise<ResolveActingActorResult> => {
  const { acting_org, request_user_id, acting_as_user_id, lookup_user } = input;

  // 1. Self-acted (no acting_org).
  if (!acting_org) {
    if (acting_as_user_id) {
      return { ok: false, status: 400, error: 'CANNOT_OVERRIDE_SELF' };
    }
    return {
      ok: true,
      effective_user_id: request_user_id,
      audit: { performed_by_org_id: null, performed_by_service_user_id: null },
    };
  }

  // 2. Tier gate: aggregator or network_service. Anything else is rejected.
  //
  //    `organization.type` is plain nullable text, so the union above is a
  //    claim about the data rather than a guarantee from the database. A row
  //    carrying a retired or unknown type reaches here and is refused — which
  //    is why this stays an explicit check rather than an exhaustiveness
  //    assertion the compiler would let us delete.
  if (
    acting_org.org_type !== 'aggregator' &&
    acting_org.org_type !== 'network_service'
  ) {
    return { ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' };
  }

  // 3. acting_as_user_id is required when acting_org is set.
  if (!acting_as_user_id) {
    return { ok: false, status: 400, error: 'MISSING_ACTING_AS_USER_ID' };
  }

  // 4. User existence (both tiers).
  const userInfo = await lookup_user(acting_as_user_id);
  if (!userInfo) {
    return { ok: false, status: 404, error: 'USER_NOT_FOUND' };
  }

  // 5. Aggregator-only: enforce onboarded_by_org_id === acting_org.org_id.
  //    network_service skips this check (network-wide scope).
  if (
    acting_org.org_type === 'aggregator' &&
    userInfo.onboardedByOrgId !== acting_org.org_id
  ) {
    return { ok: false, status: 403, error: 'NOT_AUTHORIZED_FOR_TARGET' };
  }

  return {
    ok: true,
    effective_user_id: acting_as_user_id,
    audit: {
      performed_by_org_id: acting_org.org_id,
      performed_by_service_user_id: acting_org.service_user_id,
    },
  };
};

/**
 * Shared DB lookup used by `/action/perform` when resolving the
 * on-behalf-of target user. Returns `null` for missing users, or
 * `{ onboardedByOrgId }` for users that exist (the field may itself
 * be `null` for self-registered users).
 */
export const lookup_user_for_acting = async (
  user_id: string,
): Promise<{ onboardedByOrgId: string | null } | null> => {
  const rows = await db
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, user_id))
    .limit(1);
  if (rows.length === 0) return null;
  return { onboardedByOrgId: rows[0].onboardedByOrgId };
};

/**
 * Human-readable messages for each `ResolveErr.error` code. Route
 * handlers use this when constructing their `reply.send({ error, message })`.
 */
export const action_error_messages: Record<ResolveErr['error'], string> = {
  CANNOT_OVERRIDE_SELF:
    'acting_as_user_id requires an x-acting-org-id header naming an aggregator-type or network_service-type acting org.',
  MISSING_ACTING_AS_USER_ID:
    'aggregator-type or network_service-type acting_org requires acting_as_user_id in the request body.',
  ACTING_ORG_TYPE_NOT_ALLOWED:
    'only aggregator-type or network_service-type acting orgs may act on behalf of users.',
  NOT_AUTHORIZED_FOR_TARGET:
    'acting_as_user_id is not a user onboarded by this aggregator.',
  USER_NOT_FOUND:
    'acting_as_user_id does not resolve to any user.',
};

/**
 * Header a `network_service` / `aggregator` / `voice` acting org sends to make
 * `/action/update-status` and `/action/:id/contact-details` run as one of its
 * users. Those two routes are receiver/participant-side, so they have to be
 * driven by the item owner; a channel that owns the whole registration flow
 * (YellowDot) has no per-user credential to present, so it names the user here
 * instead. It is a header rather than a body field because contact-details is a
 * GET and update-status takes a bare array.
 *
 * Omitted -> unchanged self-acted behaviour (the caller is `request.user`), so
 * existing clients are unaffected. Present -> the same tier matrix `/perform`
 * applies to `acting_as_user_id`, including the aggregator ownership check.
 */
export const ACTING_AS_USER_HEADER = 'x-acting-as-user-id';

export type ResolveCallerResult =
  | { ok: true; caller_id: string }
  | { ok: false; status: 400 | 403 | 404; error: ResolveErr['error']; message: string };

export const resolve_caller_id = async (request: {
  acting_org?: ActingOrg;
  user?: { id: string };
  headers: Record<string, string | string[] | undefined>;
}): Promise<ResolveCallerResult> => {
  const request_user_id = request.user?.id ?? '';
  const raw = request.headers[ACTING_AS_USER_HEADER];
  const acting_as_user_id = (Array.isArray(raw) ? raw[0] : raw)?.trim() || undefined;

  if (!acting_as_user_id) return { ok: true, caller_id: request_user_id };

  const actor = await resolve_acting_actor({
    acting_org: request.acting_org,
    request_user_id,
    acting_as_user_id,
    lookup_user: lookup_user_for_acting,
  });
  if (!actor.ok) {
    return {
      ok: false,
      status: actor.status,
      error: actor.error,
      message: action_error_messages[actor.error].replace(/acting_as_user_id/g, ACTING_AS_USER_HEADER),
    };
  }
  return { ok: true, caller_id: actor.effective_user_id };
};
