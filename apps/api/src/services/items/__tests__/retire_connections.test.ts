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
    source_item_network: 'blue_dot',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1.0',
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
    expect(n).toBe(1);
    expect(updates[0].action_status).toBe('cancelled');
  });

  it('cancels an accepted action too (non-terminal)', async () => {
    const { tx, updates } = makeTx([action({ action_status: 'accepted' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toBe(1);
    expect(updates[0].action_status).toBe('cancelled');
  });

  it('leaves already-terminal actions untouched (rejected / cancelled)', async () => {
    const { tx, updates } = makeTx([
      action({ action_id: 'r', action_status: 'rejected' }),
      action({ action_id: 'c', action_status: 'cancelled' }),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it('cancels via fallback when the interaction has no resolvable config', async () => {
    getNetworkConfigById.mockRejectedValue(new Error('no config'));
    const { tx, updates } = makeTx([action({ action_status: 'created' })]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const n = await cancelItemConnections(tx as any, { item_id: 'item-1', item_network: 'blue_dot', item_domain: 'seeker', item_type: 'profile_1.0' });
    expect(n).toBe(1);
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
    expect(n).toBe(1);
    expect(updates[0].action_status).toBe('cancelled');
  });
});
