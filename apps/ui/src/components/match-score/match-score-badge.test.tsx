import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { MatchScoreBadge } from './match-score-badge';

const score = (overrides: Partial<MatchScoreResult> = {}): MatchScoreResult => ({
  provider: 'signals_search',
  score: 7.1,
  ...overrides,
});

describe('MatchScoreBadge', () => {
  // #394: the backend's internal scale is 0-10, not 0-1. `getScoreStyles`
  // used to compare the raw 0-10 score directly against the 0.85/0.70/0.50
  // thresholds, so any real score above ~1 was misclassified "Excellent".
  it('bands a 0-10 score by normalizing to 0-1 before thresholding (mirrors getMatchScoreBand)', () => {
    render(<MatchScoreBadge score={score({ score: 7.1 })} showLabel />);
    expect(screen.getByText('71% Good')).toBeInTheDocument();
  });

  it('labels a high 0-10 score "Excellent" only once actually >= 8.5/10', () => {
    render(<MatchScoreBadge score={score({ score: 9 })} showLabel />);
    expect(screen.getByText('90% Excellent')).toBeInTheDocument();
  });

  it('labels a low 0-10 score "Low", not "Excellent"', () => {
    render(<MatchScoreBadge score={score({ score: 2 })} showLabel />);
    expect(screen.getByText('20% Low')).toBeInTheDocument();
  });

  // #394: a discover-seeded score (`source: 'discover'`) has no `confidence`
  // — only a real `/v1/relevance` result does. The tooltip must hide the
  // confidence line rather than render `Confidence: NaN%`.
  it('hides the confidence line in the tooltip when confidence is absent', async () => {
    const user = userEvent.setup();
    render(<MatchScoreBadge score={score({ confidence: undefined })} />);

    await user.hover(screen.getByRole('button'));
    // Radix renders the tooltip content twice (visible popper + sr-only
    // accessible span), so wait via findAllByText rather than a singular
    // findByText, which throws on multiple matches.
    await screen.findAllByText(/Good Match/i);

    expect(screen.queryAllByText(/Confidence:/i)).toHaveLength(0);
  });

  it('shows the confidence line in the tooltip when confidence is present', async () => {
    const user = userEvent.setup();
    render(<MatchScoreBadge score={score({ confidence: 0.82 })} />);

    await user.hover(screen.getByRole('button'));
    const matches = await screen.findAllByText(/Confidence: 82%/i);
    expect(matches.length).toBeGreaterThan(0);
  });
});
