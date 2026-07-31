import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { MatchScoreResult } from '@/lib/match-score-api';
import { MatchScoreModal } from './match-score-modal';

const score = (overrides: Partial<MatchScoreResult> = {}): MatchScoreResult => ({
  provider: 'signals_search',
  score: 7.1,
  ...overrides,
});

describe('MatchScoreModal', () => {
  beforeEach(() => {
    // The progress bar animates over 600ms via requestAnimationFrame; stub it
    // to resolve in one synchronous frame well past the animation duration so
    // the test observes the settled value without waiting on real time.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(performance.now() + 10_000);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // #394: the backend's internal scale is 0-10; the progress bar's target
  // value used to be `score.score * 100` (e.g. 710 for a score of 7.1)
  // instead of a 0-100 percent. The indicator's inline transform is driven
  // directly by the `value` prop passed down from `progressValue`
  // (`components/ui/progress.tsx`'s indicator style, independent of the
  // underlying Radix root's own aria-valuenow computation), so it's the most
  // direct way to assert the settled percent.
  it('sets the progress bar to score/10 as a percent, not score*100', () => {
    render(
      <MatchScoreModal
        isOpen
        onClose={() => {}}
        score={score({ score: 7.1 })}
        isLoading={false}
        localItemName="Me"
        networkItemName="Them"
        onRecalculate={() => {}}
      />,
    );

    const progressbar = screen.getByRole('progressbar');
    const indicator = progressbar.querySelector('div') as HTMLElement;
    // 71%, not 710% (score.score * 100 without the /10 normalization).
    expect(indicator.style.transform).toBe('translateX(-29%)');
  });

  it('hides the confidence line when confidence is absent (e.g. a discover-seeded score)', () => {
    render(
      <MatchScoreModal
        isOpen
        onClose={() => {}}
        score={score({ confidence: undefined, source: 'discover' })}
        isLoading={false}
        localItemName="Me"
        networkItemName="Them"
        onRecalculate={() => {}}
      />,
    );

    expect(screen.queryByText(/Confidence:/i)).toBeNull();
  });

  it('shows the confidence line when confidence is present', () => {
    render(
      <MatchScoreModal
        isOpen
        onClose={() => {}}
        score={score({ confidence: 0.82 })}
        isLoading={false}
        localItemName="Me"
        networkItemName="Them"
        onRecalculate={() => {}}
      />,
    );

    expect(screen.getByText(/Confidence: 82%/i)).toBeInTheDocument();
  });
});
