import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NetworkConfigDocument } from '@dpg/schemas';

const getNetworkConfigById = vi.fn();
vi.mock('@/network_configs', () => ({
  getNetworkConfigById: (...args: unknown[]) => getNetworkConfigById(...args),
}));

import { guardianGateBlocksGoLive } from '@/services/item_service';
import type { DbOrTx } from '@/services/item_service';

/**
 * Unit coverage for the server-authoritative U18 go-live gate. This is the
 * single source of truth used by create / promote / update, so proving it here
 * covers all three (the update path previously had NO coverage and would flip a
 * minor to `live` on a self-consent row — PR #311 review blocker #1; a null age
 * was treated as adult — blocker #2).
 */

// blue_dot seeker gated, provider ungated — mirrors examples/schemas/blue_dot.
const gatedCfg = {
  id: 'blue_dot',
  domains: [
    { id: 'seeker', guardian_consent_required: true },
    { id: 'provider', guardian_consent_required: false },
  ],
} as unknown as NetworkConfigDocument;

// Chainable exec stub: each `.select().from().where().limit()` chain resolves
// to the next queued result array (query 1 = ward age, query 2 = guardian row).
function makeExec(results: unknown[][]): DbOrTx {
  let i = 0;
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => Promise.resolve(results[i++] ?? []),
  };
  return chain as unknown as DbOrTx;
}

const item = {
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_id: 'item-1',
  created_by: 'ward-1',
};

beforeEach(() => {
  vi.clearAllMocks();
  getNetworkConfigById.mockResolvedValue(gatedCfg);
});

describe('guardianGateBlocksGoLive', () => {
  it('does not block on an ungated domain', async () => {
    const blocked = await guardianGateBlocksGoLive(makeExec([]), { ...item, item_domain: 'provider' });
    expect(blocked).toBe(false);
  });

  it('blocks (fail-closed) when age is null on a gated domain — blocker #2', async () => {
    const blocked = await guardianGateBlocksGoLive(makeExec([[]]), item);
    expect(blocked).toBe(true);
  });

  it('does not block a proven adult on a gated domain', async () => {
    const blocked = await guardianGateBlocksGoLive(makeExec([[{ age: 36 }]]), item);
    expect(blocked).toBe(false);
  });

  it('blocks a minor with no guardian profile_creation row — blocker #1', async () => {
    const blocked = await guardianGateBlocksGoLive(
      makeExec([[{ age: 14 }], []]),
      item,
    );
    expect(blocked).toBe(true);
  });

  it('does not block a minor once a guardian row exists', async () => {
    const blocked = await guardianGateBlocksGoLive(
      makeExec([[{ age: 14 }], [{ id: 'consent-1' }]]),
      item,
    );
    expect(blocked).toBe(false);
  });
});
