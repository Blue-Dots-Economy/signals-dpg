import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActionList } from '../action-list';
import { useCardSelection } from '@/hooks/use-card-selection';
import type { Action } from '@/lib/action-api';

vi.mock('react-i18next', () => ({
  // Matches the pattern used by the other actions/__tests__ files, extended
  // to tolerate an interpolation-options object (e.g. `t('x', { count })`,
  // used by BulkActionBar) instead of a string default — falls back to the
  // raw key in that case rather than rendering the options object as a child.
  useTranslation: () => ({
    t: (key: string, defaultValue?: unknown) =>
      typeof defaultValue === 'string' ? defaultValue : key,
  }),
}));

// ActionCard pulls in match-score hooks / auth context / etc. — none of that
// is under test here (Task 13 is about the list's own wiring), so it's
// replaced with a minimal stand-in that renders enough to identify the card.
vi.mock('../action-card', () => ({
  ActionCard: ({ action }: { action: Action }) => (
    <div data-testid={`action-card-${action.action_id}`}>{action.action_id}</div>
  ),
}));

function makeAction(overrides: Partial<Action> = {}): Action {
  return {
    action_id: 'a1',
    action_type: 'connect',
    action_status: 'created',
    update_count: 0,
    source_item_id: 'src-1',
    source_item_network: 'blue_dot',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1',
    source_item_owner: 'user-1',
    target_item_id: 'tgt-1',
    target_item_network: 'blue_dot',
    target_item_domain: 'provider',
    target_item_type: 'profile_1',
    target_item_owner: 'user-2',
    requirements_snapshot: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ownership_roles: ['received'],
    ...overrides,
  };
}

// A harness so `useCardSelection` (a real hook, not a context) can be used —
// ActionList takes the `selection` object as a prop, owned by the caller.
function Harness(props: Omit<Parameters<typeof ActionList>[0], 'selection'>) {
  const selection = useCardSelection();
  return <ActionList {...props} selection={selection} />;
}

const baseProps = {
  initiatedActions: [] as Action[],
  receivedActions: [] as Action[],
  isLoading: false,
  isError: false,
  error: null,
  activeTab: 'received' as const,
  onTabChange: vi.fn(),
  onStatusUpdate: vi.fn(),
  onRefresh: vi.fn(),
  isRefetching: false,
  onBulkAction: vi.fn(),
  toolbarStatus: 'All' as const,
  toolbarSort: 'recent' as const,
  activeFacets: [],
  onStatusChange: vi.fn(),
  onSortChange: vi.fn(),
  onOpenFilters: vi.fn(),
  onRemoveFacet: vi.fn(),
  onClearFilters: vi.fn(),
  hasNextPage: false,
  isFetchingNextPage: false,
  onLoadMore: vi.fn(),
};

describe('ActionList', () => {
  it('surfaces the active status as a removable token and clears it via the token ✕ (toolbar wiring)', async () => {
    const user = userEvent.setup();
    const onStatusChange = vi.fn();
    // Status is no longer an inline chip — it's set in the filters sheet and
    // shown here only as a token. With a non-"All" status, the toolbar renders
    // the removable token; clicking its ✕ resets to "All".
    render(<Harness {...baseProps} toolbarStatus="Pending" onStatusChange={onStatusChange} />);

    await user.click(screen.getByTestId('status-remove'));

    expect(onStatusChange).toHaveBeenCalledWith('All');
  });

  it('calls fetchNextPage (onLoadMore) when "Load more" is clicked and hasNextPage is true', async () => {
    const user = userEvent.setup();
    const onLoadMore = vi.fn();
    render(
      <Harness
        {...baseProps}
        receivedActions={[makeAction()]}
        hasNextPage
        onLoadMore={onLoadMore}
      />,
    );

    const loadMoreButton = screen.getByTestId('load-more-button');
    await user.click(loadMoreButton);

    expect(onLoadMore).toHaveBeenCalledTimes(1);
  });

  it('does not render "Load more" when hasNextPage is false', () => {
    render(<Harness {...baseProps} receivedActions={[makeAction()]} hasNextPage={false} />);

    expect(screen.queryByTestId('load-more-button')).not.toBeInTheDocument();
  });

  it('renders the "Nothing here yet" empty state when there are zero rows', () => {
    render(<Harness {...baseProps} receivedActions={[]} initiatedActions={[]} />);

    expect(screen.getByText('actions.empty_received_heading')).toBeInTheDocument();
  });

  it('renders every row directly (no client-side status filtering — server already filtered)', () => {
    const actions = [
      makeAction({ action_id: 'a1', action_status: 'created' }),
      makeAction({ action_id: 'a2', action_status: 'accepted' }),
      makeAction({ action_id: 'a3', action_status: 'rejected' }),
    ];
    render(<Harness {...baseProps} receivedActions={actions} />);

    expect(screen.getByTestId('action-card-a1')).toBeInTheDocument();
    expect(screen.getByTestId('action-card-a2')).toBeInTheDocument();
    expect(screen.getByTestId('action-card-a3')).toBeInTheDocument();
  });

  it('shows the passed *Total prop on the tab badge instead of the loaded-row count', () => {
    const actions = [makeAction({ action_id: 'a1' }), makeAction({ action_id: 'a2' })];
    render(<Harness {...baseProps} activeTab="received" receivedActions={actions} receivedTotal={57} />);

    const receivedTab = screen.getByRole('button', { name: /actions\.tab_received/ });
    expect(receivedTab).toHaveTextContent('57');
    expect(receivedTab).not.toHaveTextContent('2');
  });

  it('falls back to the loaded-row count when no *Total prop is passed', () => {
    const actions = [makeAction({ action_id: 'a1' }), makeAction({ action_id: 'a2' })];
    render(<Harness {...baseProps} activeTab="received" receivedActions={actions} />);

    const receivedTab = screen.getByRole('button', { name: /actions\.tab_received/ });
    expect(receivedTab).toHaveTextContent('2');
  });

  it('keeps bulk selection working: entering select mode and toggling a card surfaces the bulk bar', async () => {
    const user = userEvent.setup();
    const actions = [makeAction({ action_id: 'a1', action_status: 'created' })];
    render(<Harness {...baseProps} activeTab="received" receivedActions={actions} />);

    await user.click(screen.getByText('selection.select'));
    // The rendered SelectableCard wraps the mocked ActionCard in a
    // role="button" — that's the actual toggle target in select mode.
    await user.click(screen.getByRole('button', { name: /a1/ }));

    expect(screen.getByText('actions.bulk_reject')).toBeInTheDocument();
    expect(screen.getByText('actions.bulk_accept')).toBeInTheDocument();
  });

  // ── #771: bulk export ────────────────────────────────────────────────────
  describe('bulk export', () => {
    const sentAccepted = [makeAction({ action_id: 's1', action_status: 'accepted' })];

    it('accepted cards on Sent are NOT selectable without export', () => {
      render(<Harness {...baseProps} activeTab="initiated" initiatedActions={sentAccepted} />);
      expect(screen.queryByText('selection.select')).not.toBeInTheDocument();
    });

    it('accepted cards on Sent ARE selectable with export; Complete is not offered', async () => {
      const user = userEvent.setup();
      render(
        <Harness
          {...baseProps}
          activeTab="initiated"
          initiatedActions={sentAccepted}
          exportEnabled
          selectionSplit={{ sent: 1, received: 0 }}
        />,
      );
      await user.click(screen.getByText('selection.select'));
      await user.click(screen.getByRole('button', { name: /s1/ }));
      expect(screen.getByText('selection.n_selected')).toBeInTheDocument();
      expect(screen.queryByText('actions.bulk_complete')).not.toBeInTheDocument();
    });

    it('Received-only accepted selection still offers Complete', async () => {
      const user = userEvent.setup();
      const received = [makeAction({ action_id: 'r1', action_status: 'accepted' })];
      render(
        <Harness
          {...baseProps}
          activeTab="received"
          receivedActions={received}
          exportEnabled
          selectionSplit={{ sent: 0, received: 1 }}
        />,
      );
      await user.click(screen.getByText('selection.select'));
      await user.click(screen.getByRole('button', { name: /r1/ }));
      expect(screen.getByText('actions.bulk_complete')).toBeInTheDocument();
    });

    it('renders the export controls only when export is enabled', () => {
      const controls = <button type="button">export-controls</button>;
      const { rerender } = render(
        <Harness {...baseProps} exportControls={controls} />,
      );
      expect(screen.queryByText('export-controls')).not.toBeInTheDocument();
      rerender(<Harness {...baseProps} exportEnabled exportControls={controls} />);
      expect(screen.getByText('export-controls')).toBeInTheDocument();
    });
  });
});
