import { describe, it, expect, vi, beforeEach } from 'vitest';

const getNetworkConfigById = vi.fn();
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...a: unknown[]) => getNetworkConfigById(...a),
}));

import { cancelItemConnections } from '../retire_connections.js';

// Minimal network config the real getActionInteraction can resolve: a single
// `connect` interaction seeker→seeker with cancel status 'cancelled' and
// terminal 'rejected'.
const networkConfig = {
  id: 'blue_dot',
  actions: {
    connect: {
      interactions: [
        {
          from_domain: 'seeker',
          from_items: [],
          to_domain: 'seeker',
          to_items: [],
          metric_categories: {
            create: ['created'],
            accept: ['accepted'],
            reject: ['rejected'],
            cancel: ['cancelled'],
          },
        },
      ],
    },
  },
} as unknown;

function action(overrides: Record<string, unknown>) {
  return {
    partition_network: 'blue_dot',
    action_type: 'connect',
    action_id: 'a-1',
    action_status: 'created',
    // Retired item is the SOURCE by default; the counterparty is the target.
    source_item_id: 'item-1',
    source_item_owner: 'owner-retired',
    source_item_network: 'blue_dot',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1.0',
    target_item_id: 'item-2',
    target_item_owner: 'owner-cp',
    target_item_network: 'blue_dot',
    target_item_domain: 'seeker',
    target_item_type: 'profile_1.0',
    ...overrides,
  };
}

// tx stub: select() → chain resolving to `rows`; update() records set payloads.
function makeTx(rows: unknown[]) {
  const updates: Array<Record<string, unknown>> = [];
  const tx = {
    select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        updates.push(v);
        return { where: () => Promise.resolve() };
      },
    }),
  };
  return { tx, updates };
}

describe('cancelItemConnections', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getNetworkConfigById.mockResolvedValue(networkConfig);
  });

  it('cancels an open (created) action → first cancel status', async () => {
    const { tx, updates } = makeTx([action({ action_status: 'created' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toHaveLength(1);
    expect(updates[0].action_status).toBe('cancelled');
  });

  it('cancels an accepted action too (non-terminal)', async () => {
    const { tx, updates } = makeTx([action({ action_status: 'accepted' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toHaveLength(1);
    expect(updates[0].action_status).toBe('cancelled');
  });

  it('leaves already-terminal actions untouched (rejected / cancelled)', async () => {
    const { tx, updates } = makeTx([
      action({ action_id: 'r', action_status: 'rejected' }),
      action({ action_id: 'c', action_status: 'cancelled' }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  it('cancels via fallback when the interaction has no resolvable config', async () => {
    getNetworkConfigById.mockRejectedValue(new Error('no config'));
    const { tx, updates } = makeTx([action({ action_status: 'created' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toHaveLength(1);
    expect(updates[0].action_status).toBe('cancelled');
  });

  it('cancels an untracked interaction (metric_categories null) with the fallback status', async () => {
    const untracked = {
      id: 'blue_dot',
      actions: {
        connect: { interactions: [{ from_domain: 'seeker', from_items: [], to_domain: 'seeker', to_items: [], metric_categories: null }] },
      },
    } as unknown;
    getNetworkConfigById.mockResolvedValue(untracked);
    const { tx, updates } = makeTx([action({ action_status: 'created' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toHaveLength(1);
    expect(updates[0].action_status).toBe('cancelled');
  });

  it('returns the counterparty (non-retired side) when the retired item is the source', async () => {
    const { tx } = makeTx([action({ action_status: 'created' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toEqual([
      {
        actionId: 'a-1',
        actionType: 'connect',
        ownerUserId: 'owner-cp',
        itemId: 'item-2',
        domain: 'seeker',
        network: 'blue_dot',
      },
    ]);
  });

  it('picks the source as counterparty when the retired item is the target', async () => {
    // Retired item is item-1 on the TARGET side → counterparty is the source.
    const { tx } = makeTx([
      action({
        source_item_id: 'item-9',
        source_item_owner: 'owner-cp-9',
        target_item_id: 'item-1',
        target_item_owner: 'owner-retired',
      }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ ownerUserId: 'owner-cp-9', itemId: 'item-9' });
  });

  it('skips the self-domain case (both sides the retired item) — no self-notify', async () => {
    const { tx, updates } = makeTx([
      action({ source_item_id: 'item-1', target_item_id: 'item-1' }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    // Still cancelled, but no counterparty emitted.
    expect(updates[0].action_status).toBe('cancelled');
    expect(n).toHaveLength(0);
  });

  it('excludes already-terminal actions from the counterparty list', async () => {
    const { tx } = makeTx([
      action({ action_id: 'open', action_status: 'created' }),
      action({ action_id: 'done', action_status: 'rejected' }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toHaveLength(1);
    expect(n[0].actionId).toBe('open');
  });
});
