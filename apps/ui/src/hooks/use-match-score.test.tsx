import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Item } from '@/lib/item-api';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { useMatchScore } from './use-match-score';

vi.mock('@/lib/match-score-api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/match-score-api')>(
    '@/lib/match-score-api',
  );
  return { ...actual, calculateMatchScore: vi.fn() };
});
import { calculateMatchScore } from '@/lib/match-score-api';

const item = (id: string): Item =>
  ({
    item_id: id,
    item_network: 'blue_dot',
    item_domain: 'seeker',
    item_type: 'profile',
    item_instance_url: null,
    item_schema_url: null,
    item_state: {},
    item_locations: [],
  }) as unknown as Item;

const result = (score: number): MatchScoreResult => ({
  provider: 'test',
  score,
  signals: [{ name: 'x', impact: 'high', summary: 'y' }],
});

const dest = item('dest-1');

describe('useMatchScore', () => {
  beforeEach(() => {
    vi.mocked(calculateMatchScore).mockReset();
    localStorage.clear();
  });

  it('clears the score when the active (local) profile changes', async () => {
    vi.mocked(calculateMatchScore).mockResolvedValue(result(0.7));

    const { result: hook, rerender } = renderHook(
      ({ local }: { local: Item }) =>
        useMatchScore({ localItem: local, networkItem: dest, skipCache: true }),
      { initialProps: { local: item('profile-A') } },
    );

    await act(async () => {
      await hook.current.calculate();
    });
    await waitFor(() => expect(hook.current.score?.score).toBe(0.7));

    // Switch the active profile → the score for the previous pair must clear,
    // so the card doesn't show a score computed against a different profile.
    rerender({ local: item('profile-B') });
    expect(hook.current.score).toBeNull();
  });

  it('does not clear the score on a re-render with the same pair', async () => {
    vi.mocked(calculateMatchScore).mockResolvedValue(result(0.42));
    const sameLocal = item('profile-A');

    const { result: hook, rerender } = renderHook(
      ({ local }: { local: Item }) =>
        useMatchScore({ localItem: local, networkItem: dest, skipCache: true }),
      { initialProps: { local: sameLocal } },
    );

    await act(async () => {
      await hook.current.calculate();
    });
    await waitFor(() => expect(hook.current.score?.score).toBe(0.42));

    // New object identity, same item_id → the pair is unchanged, keep the score.
    rerender({ local: item('profile-A') });
    expect(hook.current.score?.score).toBe(0.42);
  });
});
