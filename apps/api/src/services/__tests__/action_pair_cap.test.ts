import { describe, it, expect, vi } from 'vitest';
import type { NetworkConfig } from '@dpg/config';
import {
  maxActionsPerPair,
  terminalStatuses,
  assertPairCapAvailable,
  ActionPairCapError,
} from '@/services/action_pair_cap';

const cfg = (over: Partial<NetworkConfig>): NetworkConfig => ({ id: 'blue_dot', ...over }) as NetworkConfig;

describe('maxActionsPerPair', () => {
  it('defaults to 1 when unset / non-positive', () => {
    expect(maxActionsPerPair(cfg({}))).toBe(1);
    expect(maxActionsPerPair(cfg({ max_actions_per_pair: 0 }))).toBe(1);
    expect(maxActionsPerPair(cfg({ max_actions_per_pair: -3 }))).toBe(1);
  });
  it('honours a positive configured value', () => {
    expect(maxActionsPerPair(cfg({ max_actions_per_pair: 3 }))).toBe(3);
  });
});

describe('terminalStatuses', () => {
  it('unions accept/reject/cancel buckets with the fallback set', () => {
    const t = terminalStatuses(
      cfg({
        actions: {
          apply: {
            interactions: [
              {
                from_domain: 'seeker',
                to_domain: 'provider',
                // @ts-expect-error test fixture carries metric_categories
                metric_categories: { create: ['created', 'submitted'], accept: ['accepted'], reject: ['rejected'], cancel: ['cancelled'] },
              },
            ],
          },
        },
      }) as NetworkConfig,
    );
    // buckets + fallback are terminal; the create-bucket (open) statuses are NOT
    expect(t).toEqual(expect.arrayContaining(['accepted', 'rejected', 'cancelled', 'completed']));
    expect(t).not.toContain('created');
    expect(t).not.toContain('submitted');
  });
});

describe('assertPairCapAvailable', () => {
  const terminal = ['accepted', 'cancelled', 'rejected', 'completed'];
  const args = {
    network: 'blue_dot',
    sourceItemId: 'a',
    targetItemId: 'b',
    cap: 1,
    terminal,
  };

  const makeTx = (openCount: number) => ({
    execute: vi.fn().mockResolvedValue(undefined),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => Promise.resolve([{ open: openCount }])),
      })),
    })),
  });

  it('takes the advisory lock and passes when under the cap', async () => {
    const tx = makeTx(0);
    await expect(assertPairCapAvailable(tx as never, args)).resolves.toBeUndefined();
    expect(tx.execute).toHaveBeenCalledTimes(1); // the pg_advisory_xact_lock
  });

  it('throws ActionPairCapError when the pair is already at the cap', async () => {
    const tx = makeTx(1);
    await expect(assertPairCapAvailable(tx as never, args)).rejects.toBeInstanceOf(ActionPairCapError);
  });

  it('respects a higher cap', async () => {
    const tx = makeTx(2);
    await expect(assertPairCapAvailable(tx as never, { ...args, cap: 3 })).resolves.toBeUndefined();
  });
});
