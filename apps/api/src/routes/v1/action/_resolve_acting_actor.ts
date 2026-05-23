import { eq } from 'drizzle-orm';
import { db } from '@api/db/postgres/drizzle_config';
import { user } from '@api/db/postgres/schema/auth';

export type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'voice' | 'network_service';
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
 * Two tiers are allowed today:
 *   - `aggregator`: scoped to users with `onboarded_by_org_id ===
 *     acting_org.org_id`.
 *   - `network_service`: unrestricted; any user in the network.
 *
 * Voice-typed acting_orgs are rejected (placeholder for future).
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

  // 2. Tier gate: aggregator OR network_service. Anything else (voice,
  //    unknown) is rejected.
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
    'only aggregator-type or network_service-type acting orgs may act on behalf of users today.',
  NOT_AUTHORIZED_FOR_TARGET:
    'acting_as_user_id is not a user onboarded by this aggregator.',
  USER_NOT_FOUND:
    'acting_as_user_id does not resolve to any user.',
};
