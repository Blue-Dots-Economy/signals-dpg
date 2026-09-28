import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ResultsSheetHeader } from '../results-sheet-header';

describe('ResultsSheetHeader', () => {
  it('shows visible Map / List text with the full accessible names', () => {
    render(<ResultsSheetHeader viewMode="map" onViewModeChange={vi.fn()} count={50} />);
    const map = screen.getByRole('button', { name: 'Map view' });
    expect(map).toHaveTextContent('Map');
    expect(map).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'List view' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('switches view on the other button and ignores the pressed one', async () => {
    const onViewModeChange = vi.fn();
    render(<ResultsSheetHeader viewMode="map" onViewModeChange={onViewModeChange} />);
    await userEvent.click(screen.getByRole('button', { name: 'Map view' }));
    expect(onViewModeChange).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'List view' }));
    expect(onViewModeChange).toHaveBeenCalledWith('list');
  });

  it('states the live listing count, and nothing while it loads', () => {
    const { rerender } = render(<ResultsSheetHeader viewMode="list" onViewModeChange={vi.fn()} />);
    expect(screen.getByTestId('sheet-count')).toHaveTextContent('');
    rerender(<ResultsSheetHeader viewMode="list" onViewModeChange={vi.fn()} count={38} />);
    expect(screen.getByTestId('sheet-count')).toHaveTextContent('38 listings');
  });

  it('renders the Filters and extra slots', () => {
    render(
      <ResultsSheetHeader
        viewMode="map"
        onViewModeChange={vi.fn()}
        filtersSlot={<button type="button">Filters</button>}
        extraSlot={<button type="button">Location</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Filters' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Location' })).toBeInTheDocument();
  });
});
