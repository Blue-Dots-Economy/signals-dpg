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

  it('shows a removable Status token (counted as a filter) when status is not All, and clearing it resets to All', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    render(
      <ActionToolbar
        status="Accepted"
        sort="match_score"
        activeFacets={[]}
        onStatusChange={onStatusChange}
        onSortChange={noop}
        onOpenFilters={noop}
        onRemoveFacet={noop}
        onClearFilters={noop}
      />,
    );

    // Status is no longer an inline chip group — it's a filter shown as a token.
    expect(screen.queryByTestId('status-chip-Pending')).not.toBeInTheDocument();
    expect(screen.getByTestId('status-token')).toBeInTheDocument();
    expect(screen.getByTestId('filters-count')).toHaveTextContent('1'); // status counts as one active filter

    await user.click(screen.getByTestId('status-remove'));
    expect(onStatusChange).toHaveBeenCalledWith('All');
  });

  it('shows no Status token and no count when status is All', () => {
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

    expect(screen.queryByTestId('status-token')).not.toBeInTheDocument();
    expect(screen.queryByTestId('filters-count')).not.toBeInTheDocument();
  });

  it('counts status alongside facets in the Filters badge', () => {
    render(
      <ActionToolbar
        status="Pending"
        sort="match_score"
        activeFacets={[{ field: 'subject', label: 'Subject', value: 'Maths' }]}
        onStatusChange={noop}
        onSortChange={noop}
        onOpenFilters={noop}
        onRemoveFacet={noop}
        onClearFilters={noop}
      />,
    );

    expect(screen.getByTestId('filters-count')).toHaveTextContent('2'); // status + 1 facet
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
