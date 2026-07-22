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
  | { kind: 'rejected'; status: 403; error: 'ACTING_ORG_TYPE_NOT_ALLOWED' | 'INVALID_ACTING_ORG' };

export type ResolveUpsertActionInput = {
  acting_org: ActingOrg | undefined;
  user_exists: boolean;
  item_id_in_body: string | undefined;
  has_item_state: boolean;
  /** Only meaningful when aggregator AND user_exists. */
  aggregator_owns_user: boolean;
  /**
   * The caller-resolved id of the user's existing item for this
   * (item_network, item_domain, item_type) triple, if any.
   * Only meaningful when user_exists && has_item_state && !item_id_in_body.
   * When present, triggers idempotent dedup-to-update instead of insert.
   */
  existing_owned_item_id?: string | undefined;
  /**
   * When true, force creation of a NEW item even if one of the same
   * (item_network, item_domain, item_type) already exists for the user —
   * i.e. skip the idempotent dedup-to-update (#349). Mutually exclusive
   * with item_id_in_body (the request schema rejects both together).
   * Ignored for a brand-new user (there is nothing to dedup against).
   */
  create_new?: boolean | undefined;
};

/**
 * Pure dispatcher for POST /api/v1/admin/participant. Captures the
 * authorization matrix in
 * docs/superpowers/specs/2026-05-23-admin-participant-upsert-design.md.
 *
 * No DB, no I/O. The handler runs this synchronously and then dispatches
 * on the verdict.
 *
 * Tail logic (user_exists && authorized):
 *   - item_id_in_body && has_item_state → update_item{item_id_in_body}
 *   - has_item_state && create_new → insert_item  (force an additional profile, #349)
 *   - has_item_state && existing_owned_item_id → update_item{existing_owned_item_id}
 *     (idempotent re-onboard: caller resolved a pre-existing item for this type)
 *   - has_item_state → insert_item  (first profile for this network/domain/type)
 *   - else → account_only
 *
 * The runtime check for "item belongs to this user" (which produces
 * ITEM_NOT_OWNED_BY_USER) lives in the handler AFTER the helper returns
 * `update_item` — keeping this function pure.
 */
export const resolve_upsert_action = (input: ResolveUpsertActionInput): UpsertVerdict => {
  const { acting_org, user_exists, item_id_in_body, has_item_state, aggregator_owns_user, existing_owned_item_id, create_new } = input;

  if (!acting_org) {
    return { kind: 'rejected', status: 403, error: 'INVALID_ACTING_ORG' };
  }

  if (
    acting_org.org_type !== 'aggregator' &&
    acting_org.org_type !== 'network_service'
  ) {
    return { kind: 'rejected', status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' };
  }

  if (!user_exists) {
    if (!has_item_state) return { kind: 'account_only' };
    return { kind: 'create_new_user' };
  }

  if (acting_org.org_type === 'aggregator' && !aggregator_owns_user) {
    return { kind: 'aggregator_owned_elsewhere' };
  }

  if (item_id_in_body && has_item_state) return { kind: 'update_item', item_id: item_id_in_body };
  if (has_item_state && create_new) return { kind: 'insert_item' };
  if (has_item_state && existing_owned_item_id) return { kind: 'update_item', item_id: existing_owned_item_id };
  if (has_item_state) return { kind: 'insert_item' };
  return { kind: 'account_only' };
};
