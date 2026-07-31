import { afterEach, describe, expect, it, vi } from 'vitest';
import { isFreeTextMatchScoreEnabled, shouldRenderMatchScoreCard } from './match-score-config';
import * as runtimeEnv from './runtime-env';

function mockEnv(value: string | undefined) {
  vi.spyOn(runtimeEnv, 'getRuntimeEnv').mockReturnValue(value);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isFreeTextMatchScoreEnabled', () => {
  it('defaults to true when unset', () => {
    mockEnv(undefined);
    expect(isFreeTextMatchScoreEnabled()).toBe(true);
  });

  it('defaults to true for an empty string', () => {
    mockEnv('');
    expect(isFreeTextMatchScoreEnabled()).toBe(true);
  });

  it('is true for "true"', () => {
    mockEnv('true');
    expect(isFreeTextMatchScoreEnabled()).toBe(true);
  });

  it.each(['false', 'FALSE', ' false ', '0', 'off', 'no'])(
    'is false for the disabling value %j',
    (v) => {
      mockEnv(v);
      expect(isFreeTextMatchScoreEnabled()).toBe(false);
    },
  );
});

describe('shouldRenderMatchScoreCard', () => {
  const withScore = { score: 0.42 };
  const noScore = { score: null };

  it('profile-to-profile: always true when a local profile exists (flag off, no score)', () => {
    mockEnv('false');
    expect(shouldRenderMatchScoreCard({ item_id: 'x' }, noScore)).toBe(true);
  });

  it('free-text: true when no profile but a discover score exists and flag is ON', () => {
    mockEnv(undefined);
    expect(shouldRenderMatchScoreCard(null, withScore)).toBe(true);
  });

  it('free-text: false when no profile, score exists, but flag is OFF', () => {
    mockEnv('false');
    expect(shouldRenderMatchScoreCard(null, withScore)).toBe(false);
  });

  it('false when no profile and no discover score (nothing to seed)', () => {
    mockEnv(undefined);
    expect(shouldRenderMatchScoreCard(null, noScore)).toBe(false);
  });

  it('handles a null networkItem gracefully', () => {
    mockEnv(undefined);
    expect(shouldRenderMatchScoreCard(null, null)).toBe(false);
  });
});
