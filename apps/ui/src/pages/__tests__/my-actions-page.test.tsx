import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import type { ActionStatusFilter, ActionSort, ActiveFacet } from '@/components/actions/action-toolbar';
import type { ActionTypeFilter } from '@/components/actions/action-filters-sheet';
import type { UseOwnedActionsParams } from '@/hooks/use-actions';
import { MyActionsPage as PageUnderTest } from '@/pages/my-actions-page';

// Task 13 (#439) — the page's write path: URL params <-> the toolbar/sheet
// props <-> the hook's query-shaping args. Heavy chrome (PageShell,
// ActionList's card rendering, ActionFiltersSheet's schema-derived groups —
// all covered by their own component tests) is stubbed out here so this test
// focuses purely on the page's own wiring.

// ---- Fixtures --------------------------------------------------------------

const PROVIDER_SCHEMA: RJSFSchema = {
  type: 'object',
  properties: {
    looking_for: { type: 'array', items: { enum: ['mentor', 'peer'] } },
  },
};

function buildNetwork(): DotNetworkSchema {
  return {
    id: 'blue_dot',
    display_name: 'Blue Dots',
    description: 'test network',
    schema_standard: '1.0',
    domains: [
      { id: 'seeker', description: 'Seeker' },
      { id: 'provider', description: 'Provider', item_schemas: { 'profile_1.0': PROVIDER_SCHEMA } },
    ],
    actions: {},
  };
}

const network = buildNetwork();

const liveItem: Item = {
  item_id: 'item-1',
  item_network: 'blue_dot',
  item_domain: 'seeker',
  item_type: 'profile_1.0',
  item_instance_url: null,
  item_schema_url: null,
  item_state: {},
  item_locations: [],
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  lifecycle_status: 'live',
};

// ---- Hook call recorders ---------------------------------------------------

const useInitiatedActionsMock = vi.fn();
const useReceivedActionsMock = vi.fn();

// Mirrors the `{ actions, meta: { total, limit, offset } }` page shape
// `useOwnedActionsInfinite` (`use-actions.ts`) resolves each page to.
interface StubActionsPage {
  actions: Array<{ action_id: string }>;
  meta: { total: number; limit: number; offset: number };
}

interface InfiniteQueryStub {
  data: { pages: StubActionsPage[] };
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  isRefetching: boolean;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
  refetch: () => void;
}

function infiniteQueryStub(): InfiniteQueryStub {
  return {
    data: { pages: [] },
    isLoading: false,
    isError: false,
    error: null,
    isRefetching: false,
    hasNextPage: false,
    isFetchingNextPage: false,
    fetchNextPage: vi.fn(),
    refetch: vi.fn(),
  };
}

// Overridable per-test (default `undefined` → fall back to the plain
// `infiniteQueryStub()`) so a test can supply `data.pages[0].meta.total`
// without every other test having to care about the shape.
let initiatedQueryOverride: InfiniteQueryStub | undefined;
let receivedQueryOverride: InfiniteQueryStub | undefined;

vi.mock('@/hooks/use-actions', () => ({
  useInitiatedActions: (itemId: unknown, params: unknown) => {
    useInitiatedActionsMock(itemId, params);
    return initiatedQueryOverride ?? infiniteQueryStub();
  },
  useReceivedActions: (itemId: unknown, params: unknown) => {
    useReceivedActionsMock(itemId, params);
    return receivedQueryOverride ?? infiniteQueryStub();
  },
}));

vi.mock('@/hooks/use-my-items', () => ({
  useMyItems: () => ({ data: [liveItem], isLoading: false, isFetched: true }),
}));

vi.mock('@/hooks/use-active-profile', () => ({
  useActiveProfile: () => ({
    activeProfileId: 'item-1',
    setActiveProfile: vi.fn(),
    activeItem: liveItem,
  }),
}));

vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfigs: () => ({ data: [network], isLoading: false, isError: false }),
  useResolvedNetwork: () => ({ data: network, isLoading: false, isError: false, error: null }),
}));

vi.mock('@/lib/served-binding', () => ({
  getServedScope: () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, defaultValue?: unknown) => (typeof defaultValue === 'string' ? defaultValue : key) }),
}));

vi.mock('@/components/layout/page-shell', () => ({
  PageShell: (p: { children: React.ReactNode }) => <div data-testid="shell">{p.children}</div>,
}));

vi.mock('@/components/actions/action-status-updater', () => ({
  ActionStatusUpdater: () => null,
}));
vi.mock('@/components/actions/bulk-status-dialog', () => ({
  BulkStatusDialog: () => null,
}));

// ActionList → a minimal stand-in exposing buttons that invoke the exact
// callbacks the page wires up, plus a readout of the toolbar-facing props, so
// assertions can check both "the right callback fires" and "the right value
// came back down" without depending on the real toolbar/list markup.
vi.mock('@/components/actions/action-list', () => ({
  ActionList: (props: {
    toolbarStatus: ActionStatusFilter;
    activeFacets: ActiveFacet[];
    onStatusChange: (s: ActionStatusFilter) => void;
    onSortChange: (s: ActionSort) => void;
    onOpenFilters: () => void;
    onRemoveFacet: (field: string, value: string) => void;
    onClearFilters: () => void;
    initiatedTotal?: number;
    receivedTotal?: number;
  }) => {
    return (
      <div data-testid="action-list-stub">
        <span data-testid="toolbar-status">{props.toolbarStatus}</span>
        <span data-testid="active-facets">{JSON.stringify(props.activeFacets)}</span>
        <span data-testid="initiated-total">{String(props.initiatedTotal)}</span>
        <span data-testid="received-total">{String(props.receivedTotal)}</span>
        <button data-testid="trigger-status-pending" onClick={() => props.onStatusChange('Pending')} />
        <button data-testid="trigger-open-filters" onClick={() => props.onOpenFilters()} />
        <button
          data-testid="trigger-remove-facet"
          onClick={() => props.onRemoveFacet('looking_for', 'mentor')}
        />
        <button data-testid="trigger-clear-filters" onClick={() => props.onClearFilters()} />
      </div>
    );
  },
}));

// ActionFiltersSheet → capture the `domains`/`selected`/`actionTypes` props it
// receives, plus an escape hatch to fire onChange/onActionTypesChange.
let lastFiltersSheetProps: {
  open: boolean;
  domains: Array<{ id: string }>;
  selected: Record<string, string[]>;
  actionTypes: ActionTypeFilter[];
  onChange: (next: Record<string, string[]>) => void;
  onActionTypesChange: (next: ActionTypeFilter[]) => void;
} | null = null;
vi.mock('@/components/actions/action-filters-sheet', () => ({
  ActionFiltersSheet: (props: typeof lastFiltersSheetProps) => {
    lastFiltersSheetProps = props;
    if (!props?.open) return null;
    return (
      <div data-testid="filters-sheet-stub">
        <button
          data-testid="trigger-add-facet"
          onClick={() => props.onChange({ looking_for: ['mentor'] })}
        />
        <button
          data-testid="trigger-set-action-type"
          onClick={() => props.onActionTypesChange(['connect'])}
        />
      </div>
    );
  },
}));

function renderPage(initialPath = '/my-actions') {
  const queryClient = new QueryClient();
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <PageUnderTest />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  useInitiatedActionsMock.mockClear();
  useReceivedActionsMock.mockClear();
  lastFiltersSheetProps = null;
  initiatedQueryOverride = undefined;
  receivedQueryOverride = undefined;
});

describe('MyActionsPage — filter/sort write path (#439 Task 13)', () => {
  it('defaults to the "All" status chip and passes no status filter to the hooks', async () => {
    renderPage();
    await waitFor(() => expect(useReceivedActionsMock).toHaveBeenCalled());

    expect(screen.getByTestId('toolbar-status').textContent).toBe('All');
    const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
    expect(params.status).toBeUndefined();
  });

  it('clicking the Pending status chip updates the URL and maps to raw statuses for the hooks', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(useReceivedActionsMock).toHaveBeenCalled());

    await user.click(screen.getByTestId('trigger-status-pending'));

    await waitFor(() => expect(screen.getByTestId('toolbar-status').textContent).toBe('Pending'));
    const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
    expect(params.status).toEqual(['created', 'pending']);
  });

  it('opening the filters button opens the sheet with the counterparty domain(s)', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(lastFiltersSheetProps).not.toBeNull());
    expect(lastFiltersSheetProps?.open).toBe(false);

    await user.click(screen.getByTestId('trigger-open-filters'));

    await waitFor(() => expect(lastFiltersSheetProps?.open).toBe(true));
    // The active profile is on `seeker` — the sheet should offer the
    // counterparty ("provider") domain, not the viewer's own.
    expect(lastFiltersSheetProps?.domains.map((d) => d.id)).toEqual(['provider']);
  });

  it('selecting a facet in the sheet round-trips through the URL into the hook facets and the toolbar tokens', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(lastFiltersSheetProps).not.toBeNull());

    await user.click(screen.getByTestId('trigger-open-filters'));
    await waitFor(() => expect(lastFiltersSheetProps?.open).toBe(true));
    await user.click(screen.getByTestId('trigger-add-facet'));

    await waitFor(() => {
      const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
      expect(params.facets).toEqual([{ field: 'looking_for', values: ['mentor'] }]);
    });
    const activeFacets = JSON.parse(screen.getByTestId('active-facets').textContent ?? '[]');
    expect(activeFacets).toEqual([{ field: 'looking_for', label: 'Looking For', value: 'mentor' }]);
  });

  it('removing a facet via the toolbar token clears it from the hook facets', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(lastFiltersSheetProps).not.toBeNull());
    await user.click(screen.getByTestId('trigger-open-filters'));
    await waitFor(() => expect(lastFiltersSheetProps?.open).toBe(true));
    await user.click(screen.getByTestId('trigger-add-facet'));
    await waitFor(() => {
      const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
      expect(params.facets).toEqual([{ field: 'looking_for', values: ['mentor'] }]);
    });

    await user.click(screen.getByTestId('trigger-remove-facet'));

    await waitFor(() => {
      const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
      expect(params.facets).toEqual([]);
    });
  });

  it('setting an action type in the sheet is forwarded to the hooks as `type`', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(lastFiltersSheetProps).not.toBeNull());
    await user.click(screen.getByTestId('trigger-open-filters'));
    await waitFor(() => expect(lastFiltersSheetProps?.open).toBe(true));

    await user.click(screen.getByTestId('trigger-set-action-type'));

    await waitFor(() => {
      const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
      expect(params.type).toEqual(['connect']);
    });
  });

  it('"Clear all" removes every facet and the action type from the hook params', async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => expect(lastFiltersSheetProps).not.toBeNull());
    await user.click(screen.getByTestId('trigger-open-filters'));
    await waitFor(() => expect(lastFiltersSheetProps?.open).toBe(true));
    await user.click(screen.getByTestId('trigger-add-facet'));
    await user.click(screen.getByTestId('trigger-set-action-type'));
    await waitFor(() => {
      const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
      expect(params.facets).toEqual([{ field: 'looking_for', values: ['mentor'] }]);
    });

    await user.click(screen.getByTestId('trigger-clear-filters'));

    await waitFor(() => {
      const [, params] = useReceivedActionsMock.mock.calls.at(-1) as [unknown, UseOwnedActionsParams];
      expect(params.facets).toEqual([]);
      expect(params.type).toBeUndefined();
    });
  });

  it('derives *Total from the first page meta.total, not the loaded-row count', async () => {
    initiatedQueryOverride = {
      ...infiniteQueryStub(),
      data: {
        pages: [
          { actions: [{ action_id: 'a1' }], meta: { total: 12, limit: 1, offset: 0 } },
        ],
      },
    };
    receivedQueryOverride = {
      ...infiniteQueryStub(),
      data: {
        pages: [
          { actions: [{ action_id: 'b1' }, { action_id: 'b2' }], meta: { total: 34, limit: 2, offset: 0 } },
        ],
      },
    };

    renderPage();

    await waitFor(() => expect(screen.getByTestId('received-total').textContent).toBe('34'));
    expect(screen.getByTestId('initiated-total').textContent).toBe('12');
  });
});
