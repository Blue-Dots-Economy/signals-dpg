import { describe, it, expect } from 'vitest';
import { formatScorePercentage, getMatchScoreBand } from './match-score-cache';

// #394: the match-score API's internal scale is 0-10 (not 0-1) — these lock
// down the correct mapping for a real-world discover-seeded score (0.71 on
// the raw discover scale → 7.1 internal → "71%" / "Good Match").
describe('formatScorePercentage', () => {
  it('maps a 0-10 score to the equivalent percentage', () => {
    expect(formatScorePercentage(7.1)).toBe('71%');
    expect(formatScorePercentage(10)).toBe('100%');
    expect(formatScorePercentage(0)).toBe('0%');
  });
});

describe('getMatchScoreBand', () => {
  it('bands a 0-10 score using the 0.85/0.70/0.50 thresholds on the normalized (0-1) value', () => {
    expect(getMatchScoreBand(9).label).toBe('Excellent Match');
    expect(getMatchScoreBand(7.1).label).toBe('Good Match');
    expect(getMatchScoreBand(5).label).toBe('Moderate Match');
    expect(getMatchScoreBand(2).label).toBe('Low Match');
  });
});
