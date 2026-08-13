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
};

/**
 * Pure dispatcher for POST /api/v1/admin/participant. Captures the
 * authorization matrix in
 * docs/superpowers/specs/2026-05-23-admin-participant-upsert-design.md.
 *
 * No DB, no I/O. The handler runs this synchronously and then dispatches
 * on the verdict.
 *
 * Semantics (#349): a create is ALWAYS an insert. Sending item_state without
 * item_id creates a NEW profile every call (a user may hold multiple profiles,
 * bounded by MAX_PROFILES_PER_USER enforced downstream). item_id targets a
 * specific existing item for an update. There is no dedup-to-update.
 *
 * Tail logic (user_exists && authorized):
 *   - item_id_in_body → update_item{item_id_in_body}   (with or without item_state)
 *   - has_item_state → insert_item   (always a new profile)
 *   - else → account_only
 *
 * The runtime check for "item belongs to this user" (which produces
 * ITEM_NOT_OWNED_BY_USER) lives in the handler AFTER the helper returns
 * `update_item` — keeping this function pure.
 */
export const resolve_upsert_action = (input: ResolveUpsertActionInput): UpsertVerdict => {
  const { acting_org, user_exists, item_id_in_body, has_item_state, aggregator_owns_user } = input;

  if (!acting_org) {
    return { kind: 'rejected', status: 403, error: 'INVALID_ACTING_ORG' };
  }

  // `voice` joins aggregator and network_service: voice-dpg is an integrating
  // DPG on the same client-credentials footing, and the layers below already
  // admit it (`SERVICE_ORG_TYPES`, `ALLOWED_ORG_TYPES`).
  //
  // It does NOT pick up the aggregator ownership rule below — `aggregator_owns_user`
  // is only consulted for `org_type === 'aggregator'`, so voice behaves like
  // network_service and may upsert any user. That is deliberate: "the
  // aggregator that onboarded this person" has no voice equivalent.
  if (
    acting_org.org_type !== 'aggregator' &&
    acting_org.org_type !== 'network_service' &&
    acting_org.org_type !== 'voice'
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

  // item_id targets an existing profile — with or without item_state (#309):
  // a consent-only / DOB-only activation can update that profile without
  // re-sending its fields. item_state without item_id is still a new insert.
  if (item_id_in_body) return { kind: 'update_item', item_id: item_id_in_body };
  if (has_item_state) return { kind: 'insert_item' };
  return { kind: 'account_only' };
};
