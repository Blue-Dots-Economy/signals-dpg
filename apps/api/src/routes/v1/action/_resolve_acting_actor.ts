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
  status: 400 | 403;
  error:
    | 'CANNOT_OVERRIDE_SELF'
    | 'MISSING_ACTING_AS_USER_ID'
    | 'ACTING_ORG_TYPE_NOT_ALLOWED'
    | 'NOT_AUTHORIZED_FOR_TARGET';
};

export type ResolveActingActorResult = ResolveOk | ResolveErr;

export type ResolveActingActorInput = {
  acting_org: ActingOrg | undefined;
  request_user_id: string;
  acting_as_user_id: string | undefined;
  /**
   * Returns `user.onboarded_by_org_id` for the given user_id, or `null`
   * if the user does not exist or has no attribution.
   */
  lookup_onboarded_by: (user_id: string) => Promise<string | null>;
};

/**
 * Single source of truth for the aggregator on-behalf-of authorization
 * matrix documented in
 * docs/superpowers/specs/2026-05-22-action-perform-on-behalf-of-design.md.
 */
export const resolve_acting_actor = async (
  input: ResolveActingActorInput,
): Promise<ResolveActingActorResult> => {
  const { acting_org, request_user_id, acting_as_user_id, lookup_onboarded_by } = input;

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

  if (acting_org.org_type !== 'aggregator') {
    return { ok: false, status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' };
  }

  if (!acting_as_user_id) {
    return { ok: false, status: 400, error: 'MISSING_ACTING_AS_USER_ID' };
  }

  const onboarded_by = await lookup_onboarded_by(acting_as_user_id);
  if (onboarded_by !== acting_org.org_id) {
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
 * Shared lookup used by both perform_action and update_action_status when
 * resolving the on-behalf-of target user. Returns `user.onboarded_by_org_id`
 * for the given user_id, or `null` if the user does not exist or has no
 * attribution.
 */
export const lookup_onboarded_by_org = async (
  user_id: string,
): Promise<string | null> => {
  const rows = await db
    .select({ onboardedByOrgId: user.onboardedByOrgId })
    .from(user)
    .where(eq(user.id, user_id))
    .limit(1);
  return rows[0]?.onboardedByOrgId ?? null;
};

/**
 * Human-readable messages for each `ResolveErr.error` code. Route handlers
 * use this when constructing their `reply.send({ error, message })`.
 */
export const action_error_messages: Record<ResolveErr['error'], string> = {
  CANNOT_OVERRIDE_SELF:
    'acting_as_user_id requires an x-acting-org-id header naming an aggregator-type acting org.',
  MISSING_ACTING_AS_USER_ID:
    'aggregator-type acting_org requires acting_as_user_id in the request body.',
  ACTING_ORG_TYPE_NOT_ALLOWED:
    'only aggregator-type acting orgs may act on behalf of users today.',
  NOT_AUTHORIZED_FOR_TARGET:
    'acting_as_user_id is not a user onboarded by this aggregator.',
};
