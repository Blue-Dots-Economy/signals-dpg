import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionToolbar } from '../action-toolbar';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, defaultValue?: string) => defaultValue ?? key }),
}));

function noop() {}

describe('ActionToolbar', () => {
  it('calls onSortChange("recent") when "Newest first" is picked from the sort menu', async () => {
    const user = userEvent.setup();
    const onSortChange = vi.fn();
    render(
      <ActionToolbar
        status="All"
        sort="match_score"
        activeFacets={[]}
        onStatusChange={noop}
        onSortChange={onSortChange}
        onOpenFilters={noop}
        onRemoveFacet={noop}
        onClearFilters={noop}
      />,
    );

    await user.click(screen.getByTestId('sort-trigger'));
    await user.click(await screen.findByTestId('sort-option-recent'));

    expect(onSortChange).toHaveBeenCalledWith('recent');
  });

  it('calls onStatusChange with the clicked status chip', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    render(
      <ActionToolbar
        status="All"
        sort="match_score"
        activeFacets={[]}
        onStatusChange={onStatusChange}
        onSortChange={noop}
        onOpenFilters={noop}
        onRemoveFacet={noop}
        onClearFilters={noop}
      />,
    );

    await user.click(screen.getByTestId('status-chip-Pending'));

    expect(onStatusChange).toHaveBeenCalledWith('Pending');
  });

  it('marks the active status chip so it is visually distinguishable', () => {
    render(
      <ActionToolbar
        status="Accepted"
        sort="match_score"
        activeFacets={[]}
        onStatusChange={noop}
        onSortChange={noop}
        onOpenFilters={noop}
        onRemoveFacet={noop}
        onClearFilters={noop}
      />,
    );

    expect(screen.getByTestId('status-chip-Accepted')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('status-chip-All')).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows the active-facet count on the Filters button, calls onOpenFilters, and removes a facet token via its ✕', async () => {
    const user = userEvent.setup();
    const onOpenFilters = vi.fn();
    const onRemoveFacet = vi.fn();
    render(
      <ActionToolbar
        status="All"
        sort="match_score"
        activeFacets={[{ field: 'subject', label: 'Subject', value: 'Maths' }]}
        onStatusChange={noop}
        onSortChange={noop}
        onOpenFilters={onOpenFilters}
        onRemoveFacet={onRemoveFacet}
        onClearFilters={noop}
      />,
    );

    expect(screen.getByTestId('filters-count')).toHaveTextContent('1');

    await user.click(screen.getByTestId('filters-button'));
    expect(onOpenFilters).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('facet-remove-subject-Maths'));
    expect(onRemoveFacet).toHaveBeenCalledWith('subject', 'Maths');
  });

  it('does not render the facet-token row or count badge when there are no active facets', () => {
    render(
      <ActionToolbar
        status="All"
        sort="match_score"
        activeFacets={[]}
        onStatusChange={noop}
        onSortChange={noop}
        onOpenFilters={noop}
        onRemoveFacet={noop}
        onClearFilters={noop}
      />,
    );

    expect(screen.queryByTestId('filters-count')).not.toBeInTheDocument();
    expect(screen.queryByTestId('clear-filters')).not.toBeInTheDocument();
  });

  it('calls onClearFilters when "Clear all" is clicked', async () => {
    const user = userEvent.setup();
    const onClearFilters = vi.fn();
    render(
      <ActionToolbar
        status="All"
        sort="match_score"
        activeFacets={[
          { field: 'subject', label: 'Subject', value: 'Maths' },
          { field: 'class', label: 'Class', value: 'Class 10' },
        ]}
        onStatusChange={noop}
        onSortChange={noop}
        onOpenFilters={noop}
        onRemoveFacet={noop}
        onClearFilters={onClearFilters}
      />,
    );

    expect(screen.getByTestId('filters-count')).toHaveTextContent('2');

    await user.click(screen.getByTestId('clear-filters'));
    expect(onClearFilters).toHaveBeenCalledTimes(1);
  });
});
