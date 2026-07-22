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

  it('aggregator + existing OWN user + item_state + no existing_owned_item_id -> insert_item', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: true,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('aggregator + existing OWN user + item_state + existing_owned_item_id -> update_item (idempotent re-onboard)', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: true,
      existing_owned_item_id: '44444444-4444-4444-8444-444444444444',
    });
    expect(v).toEqual({ kind: 'update_item', item_id: '44444444-4444-4444-8444-444444444444' });
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

  it('network_service + new user + no item_state -> account_only', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('network_service + new user + item_id (item_id ignored) + item_state -> create_new_user', () => {
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
    expect(v).toEqual({
      kind: 'update_item',
      item_id: '33333333-3333-4333-8333-333333333333',
    });
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

  it('network_service + existing user + item_state + no item_id + no existing_owned_item_id -> insert_item', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('network_service + existing user + item_state + no item_id + existing_owned_item_id -> update_item (idempotent re-onboard)', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
      existing_owned_item_id: '55555555-5555-4555-8555-555555555555',
    });
    expect(v).toEqual({ kind: 'update_item', item_id: '55555555-5555-4555-8555-555555555555' });
  });

  it('item_id_in_body takes priority over existing_owned_item_id when both present', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: '33333333-3333-4333-8333-333333333333',
      has_item_state: true,
      aggregator_owns_user: false,
      existing_owned_item_id: '55555555-5555-4555-8555-555555555555',
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

  // create_new: force a new profile even when a same-type one already exists (#349)
  it('create_new overrides idempotent update: network_service + existing user + item_state + create_new + existing_owned_item_id -> insert_item', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
      existing_owned_item_id: '55555555-5555-4555-8555-555555555555',
      create_new: true,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('create_new overrides idempotent update: aggregator + OWN user + item_state + create_new + existing_owned_item_id -> insert_item', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: true,
      existing_owned_item_id: '44444444-4444-4444-8444-444444444444',
      create_new: true,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('create_new + existing user + item_state + no existing item -> insert_item (same as default)', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
      create_new: true,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('create_new is a no-op for a brand-new user (still create_new_user)', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: false,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
      create_new: true,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('create_new does NOT bypass aggregator ownership (owned elsewhere still wins)', () => {
    const v = resolve_upsert_action({
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: true,
      aggregator_owns_user: false,
      create_new: true,
    });
    expect(v).toEqual({ kind: 'aggregator_owned_elsewhere' });
  });

  it('create_new without item_state -> account_only (nothing to create)', () => {
    const v = resolve_upsert_action({
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
      has_item_state: false,
      aggregator_owns_user: false,
      create_new: true,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });
});
