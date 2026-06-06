type ActingOrg = {
  org_id: string;
  org_type: 'aggregator' | 'voice' | 'network_service';
  service_user_id: string;
};

export type UpsertVerdict =
  | { kind: 'create_new_user' }
  | { kind: 'account_only' }
  | { kind: 'aggregator_owned_elsewhere' }
  | { kind: 'update_item'; item_id: string }
  | { kind: 'insert_item' }
  | {
      kind: 'rejected';
      status: 403;
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED' | 'INVALID_ACTING_ORG';
    };

export type ResolveUpsertActionInput = {
  acting_org: ActingOrg | undefined;
  user_exists: boolean;
  item_id_in_body: string | undefined;
  has_item_state: boolean;
  /**
   * Only meaningful when `acting_org.org_type === 'aggregator'` AND `user_exists`.
   * Pass the handler's pre-computed `existing.onboardedByOrgId === acting_org.org_id`
   * flag.
   */
  aggregator_owns_user: boolean;
};

/**
 * Pure dispatcher for POST /api/v1/admin/participant.
 *
 * Spec-driven by 2026-06-03-participant-onboarding-lifecycle-design.md §8.
 *
 * No DB, no I/O.
 */
export const resolve_upsert_action = (
  input: ResolveUpsertActionInput,
): UpsertVerdict => {
  const {
    acting_org,
    user_exists,
    item_id_in_body,
    has_item_state,
    aggregator_owns_user,
  } = input;

  if (!acting_org) {
    return { kind: 'rejected', status: 403, error: 'INVALID_ACTING_ORG' };
  }
  if (
    acting_org.org_type !== 'aggregator' &&
    acting_org.org_type !== 'network_service'
  ) {
    return {
      kind: 'rejected',
      status: 403,
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
    };
  }

  if (!user_exists) {
    if (!has_item_state) return { kind: 'account_only' };
    return { kind: 'create_new_user' };
  }

  // user exists.
  if (acting_org.org_type === 'aggregator' && !aggregator_owns_user) {
    return { kind: 'aggregator_owned_elsewhere' };
  }

  // network_service OR aggregator that owns the user.
  if (item_id_in_body) return { kind: 'update_item', item_id: item_id_in_body };
  if (has_item_state) return { kind: 'insert_item' };
  return { kind: 'account_only' };
};
