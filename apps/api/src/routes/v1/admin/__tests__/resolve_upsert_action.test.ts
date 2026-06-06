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

const base = {
  has_item_state: true,
  aggregator_owns_user: false,
};

describe('resolve_upsert_action', () => {
  it('rejects when acting_org is undefined', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: undefined,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({
      kind: 'rejected',
      status: 403,
      error: 'INVALID_ACTING_ORG',
    });
  });

  it('rejects voice-typed acting_org', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: voice,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({
      kind: 'rejected',
      status: 403,
      error: 'ACTING_ORG_TYPE_NOT_ALLOWED',
    });
  });

  it('aggregator + new user + item_state -> create_new_user', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: aggregator,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('aggregator + new user + no item_state -> account_only', () => {
    const v = resolve_upsert_action({
      ...base,
      has_item_state: false,
      acting_org: aggregator,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('aggregator + existing user + !owns -> aggregator_owned_elsewhere', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      aggregator_owns_user: false,
    });
    expect(v).toEqual({ kind: 'aggregator_owned_elsewhere' });
  });

  it('aggregator + existing user + owns + item_state -> insert_item', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      aggregator_owns_user: true,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('aggregator + existing user + owns + item_id -> update_item', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: '11111111-1111-4111-8111-111111111111',
      aggregator_owns_user: true,
    });
    expect(v).toEqual({
      kind: 'update_item',
      item_id: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('aggregator + existing user + owns + no item_state, no item_id -> account_only', () => {
    const v = resolve_upsert_action({
      ...base,
      has_item_state: false,
      acting_org: aggregator,
      user_exists: true,
      item_id_in_body: undefined,
      aggregator_owns_user: true,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('network_service + new user + item_state -> create_new_user', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('network_service + new user + no item_state -> account_only', () => {
    const v = resolve_upsert_action({
      ...base,
      has_item_state: false,
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });

  it('network_service + new user + item_id (item_id ignored) -> create_new_user', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: networkService,
      user_exists: false,
      item_id_in_body: '22222222-2222-4222-8222-222222222222',
    });
    expect(v).toEqual({ kind: 'create_new_user' });
  });

  it('network_service + existing user + item_id -> update_item', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: '33333333-3333-4333-8333-333333333333',
    });
    expect(v).toEqual({
      kind: 'update_item',
      item_id: '33333333-3333-4333-8333-333333333333',
    });
  });

  it('network_service + existing user + no item_id -> insert_item', () => {
    const v = resolve_upsert_action({
      ...base,
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'insert_item' });
  });

  it('network_service + existing user + no item_state + no item_id -> account_only', () => {
    const v = resolve_upsert_action({
      ...base,
      has_item_state: false,
      acting_org: networkService,
      user_exists: true,
      item_id_in_body: undefined,
    });
    expect(v).toEqual({ kind: 'account_only' });
  });
});
