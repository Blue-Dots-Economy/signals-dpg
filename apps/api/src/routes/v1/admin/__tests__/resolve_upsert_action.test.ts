import { describe, it, expect } from 'vitest';
import { resolve_upsert_action } from '../_resolve_upsert_action.js';

const aggregator = {
  org_id: 'org_agg_a',
  org_type: 'aggregator' as const,
  service_user_id: 'svc_agg',
};
const networkService = {
  org_id: 'org_signals',
  org_type: 'network_service' as const,
  service_user_id: 'svc_signals',
};
const voice = {
  org_id: 'org_voice_x',
  org_type: 'voice' as const,
  service_user_id: 'svc_voice',
};

describe('resolve_upsert_action', () => {
  it('rejects when acting_org is undefined', () => {
    const v = resolve_upsert_action({
      acting_org: undefined,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'rejected', status: 403, error: 'INVALID_ACTING_ORG' });
  });

  it('rejects voice-typed acting_org', () => {
    const v = resolve_upsert_action({
      acting_org: voice,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'rejected', status: 403, error: 'ACTING_ORG_TYPE_NOT_ALLOWED' });
  });

  it('aggregator + new user + item_state -> create_new_user', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('aggregator + new user + no item_state -> account_only', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('aggregator + existing user + does NOT own -> aggregator_owned_elsewhere', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'aggregator_owned_elsewhere' });
  });

  it('aggregator + existing user + item_id + does NOT own -> aggregator_owned_elsewhere', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: '11111111-1111-4111-8111-111111111111',
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'aggregator_owned_elsewhere' });
  });

  // #349: a create is ALWAYS an insert (no dedup-to-update).
  it('aggregator + existing OWN user + item_state + no item_id -> insert_item (always a new profile)', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: true,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('repeat call with same body -> still insert_item (creates another profile)', () => {
    const input = {
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
    };
    expect(resolve_upsert_action(input)).toEqual({ kind: 'insert_item' });
    expect(resolve_upsert_action(input)).toEqual({ kind: 'insert_item' });
  });

  it('aggregator + existing OWN user + item_id + item_state -> update_item', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: '22222222-2222-4222-8222-222222222222',
      has_item_state: true,
      aggregator_owns_user: true,
    });
    expect(v).toEqual({ kind: 'update_item', item_id: '22222222-2222-4222-8222-222222222222' });
  });

  it('aggregator + existing OWN user + item_id + NO item_state -> account_only', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: '22222222-2222-4222-8222-222222222222',
      has_item_state: false,
      aggregator_owns_user: true,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('network_service + new user + no item_state -> account_only (create the account only)', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('network_service + new user + item_state -> create_new_user', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('network_service + new user + item_id (ignored) + item_state -> create_new_user', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: '22222222-2222-4222-8222-222222222222',
      has_item_state: true,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('network_service + existing user + item_id + item_state -> update_item', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: '33333333-3333-4333-8333-333333333333',
      has_item_state: true,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'update_item', item_id: '33333333-3333-4333-8333-333333333333' });
  });

  it('network_service + existing user + item_id + NO item_state -> account_only', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: '33333333-3333-4333-8333-333333333333',
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('network_service + existing user + item_state + no item_id -> insert_item', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('item_id takes priority (update) even when item_state present', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: '33333333-3333-4333-8333-333333333333',
      has_item_state: true,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'update_item', item_id: '33333333-3333-4333-8333-333333333333' });
  });

  it('network_service + existing user + no item_state + no item_id -> account_only', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });
});
