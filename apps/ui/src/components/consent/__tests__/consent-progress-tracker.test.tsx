import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConsentProgressTracker } from '@/components/consent/consent-progress-tracker';
import type { ReadProgress } from '@/components/consent/read-progress';

const docs = [
  { id: 'privacy', cap: 'Privacy' },
  { id: 'terms', cap: 'Terms' },
];

const noProgress: ReadProgress = {
  readIds: [],
  currentId: 'privacy',
  fillPercent: 0,
  allRead: false,
};

describe('ConsentProgressTracker', () => {
  it('marks the first document current and the rest todo at the start', () => {
    render(<ConsentProgressTracker docs={docs} progress={noProgress} />);

    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'todo');
  });

  it('marks a document read and reflects the fill percent in the fill width', () => {
    const progress: ReadProgress = {
      readIds: ['privacy'],
      currentId: 'terms',
      fillPercent: 50,
      allRead: false,
    };

    render(<ConsentProgressTracker docs={docs} progress={progress} />);

    expect(screen.getByTestId('consent-node-privacy')).toHaveAttribute('data-state', 'read');
    expect(screen.getByTestId('consent-node-terms')).toHaveAttribute('data-state', 'current');
    expect(screen.getByTestId('consent-progress-fill')).toHaveStyle({ width: '50%' });
  });

  it('renders nothing for a single document', () => {
    const { container } = render(
      <ConsentProgressTracker docs={[docs[0]]} progress={noProgress} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
