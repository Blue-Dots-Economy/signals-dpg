import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import type { Action, FetchMyActionsQuery } from '@/lib/action-api';
import type { Item } from '@/lib/item-api';

// My Actions revamp — page wiring: one paged query built from the URL, saved
// views, chips, pagination, per-row commands, bulk respond and per-type export.
// The toolbar's Radix menus are exercised in their own right elsewhere; here
// the URL is the input and the query / callbacks are the output.

const statusEvent = { type: 'object', properties: { status: { type: 'string', enum: ['created', 'accepted', 'completed', 'rejected'] } } };
const inter = (from: string, to: string, requester?: string[]) => ({
  from_domain: from,
  to_domain: to,
  requirement_schema: { type: 'object' },
  event_schema: statusEvent,
  metric_categories: { create: ['created'] },
  reveals_pii_on_status: ['accepted', 'completed'],
  ...(requester ? { export: { requester_domains: requester } } : {}),
});
const network = {
  id: 'blue_dot',
  display_name: 'Blue Dots',
  description: '',
  schema_standard: '1.0',
  domains: [
    {
      id: 'seeker',
      label: 'Seeker',
      item_schemas: { 'profile_1.0': { type: 'object', properties: { educationCategory: { type: 'string', title: 'Education', enum: ['10th', '12th'] } } } },
    },
    { id: 'provider', label: 'Provider', item_schemas: { 'profile_1.0': { type: 'object', properties: { name: { type: 'string' } } } } },
    { id: 'service_provider', label: 'Service Provider', item_schemas: {} },
  ],
  actions: {
    apply: { description: '', interactions: [inter('seeker', 'provider', ['provider'])] },
    connect: {
      description: '',
      interactions: [inter('provider', 'seeker', ['provider']), inter('provider', 'service_provider', ['provider'])],
    },
  },
} as unknown as DotNetworkSchema;

const myItem = (id: string, name: string) =>
  ({ item_id: id, item_network: 'blue_dot', item_domain: 'provider', item_type: 'profile_1.0', item_state: { name }, lifecycle_status: 'live' }) as unknown as Item;
const items = [myItem('p1', 'ABC ltd'), myItem('p2', 'Test Nest')];

const row = (id: string, over: Partial<Action> = {}): Action =>
  ({
    action_id: id,
    action_type: 'apply',
    action_status: 'created',
    ownership_roles: ['received'],
    source_item_id: `s-${id}`,
    source_item_network: 'blue_dot',
    source_item_domain: 'seeker',
    source_item_type: 'profile_1.0',
    source_item_name: 'A***',
    target_item_id: 'p1',
    target_item_network: 'blue_dot',
    target_item_domain: 'provider',
    target_item_type: 'profile_1.0',
    target_item_name: 'ABC ltd',
    updated_at: '2026-09-29T09:00:00Z',
    created_at: '2026-09-29T09:00:00Z',
    requirements_snapshot: {},
    match_score: 8.2,
    distance_m: 2300,
    counterparty: { network: 'blue_dot', domain: 'seeker', item_type: 'profile_1.0', summary: { educationCategory: '12th' } },
    ...over,
  }) as unknown as Action;

let rows: Action[] = [];
let total = 0;
const queries: FetchMyActionsQuery[] = [];
vi.mock('@/hooks/use-actions', () => ({
  useOwnedActionsPage: (q: FetchMyActionsQuery) => {
    queries.push(q);
    return {
      data: { actions: rows, meta: { total, limit: q.limit, offset: q.offset, counts: { all: total, needs_response: 1, ready_to_export: 2, sent: 0 } } },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn(),
    };
  },
}));
vi.mock('@/hooks/use-my-items', () => ({ useMyItems: () => ({ data: items, isLoading: false, isFetched: true }) }));
vi.mock('@/hooks/use-active-profile', () => ({
  useActiveProfile: () => ({ activeProfileId: 'p1', setActiveProfile: vi.fn(), activeItem: items[0] }),
}));
vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfigs: () => ({ data: [network], isLoading: false, isError: false }),
  useResolvedNetwork: () => ({ data: network, isLoading: false, isError: false, error: null }),
}));
vi.mock('@/lib/served-binding', () => ({ getServedScope: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: unknown, opts?: Record<string, unknown>) => {
      const fallback = typeof fallbackOrOpts === 'string' ? fallbackOrOpts : key;
      const vars = (typeof fallbackOrOpts === 'object' ? fallbackOrOpts : opts) as Record<string, unknown> | undefined;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''));
    },
  }),
}));
vi.mock('@/components/layout/page-shell', () => ({
  PageShell: (p: { children: React.ReactNode; onBack?: () => void }) => (
    <div>
      <button type="button" onClick={p.onBack}>
        Back
      </button>
      {p.children}
    </div>
  ),
}));
const statusUpdater = vi.fn();
vi.mock('@/components/actions/action-status-updater', () => ({
  ActionStatusUpdater: (p: { open: boolean; action: Action | null; suggestedStatus: string }) => {
    if (p.open) statusUpdater(p.action?.action_id, p.suggestedStatus);
    return null;
  },
}));
const bulkDialog = vi.fn();
vi.mock('@/components/actions/bulk-status-dialog', () => ({
  BulkStatusDialog: (p: { open: boolean; actions: Action[]; targetStatus: string }) => {
    if (p.open) bulkDialog(p.actions.map((a) => a.action_id), p.targetStatus);
    return null;
  },
}));
vi.mock('@/components/actions/profile-card-modal', () => ({ ProfileCardModal: () => <div data-testid="profile-modal" /> }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const exportActionsMock = vi.fn();
vi.mock('@/lib/action-export', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/action-export')>();
  return { ...real, exportActions: (...a: unknown[]) => exportActionsMock(...a), saveBlob: vi.fn() };
});

const { MyActionsPage } = await import('../my-actions-page');

let location = '';
function LocationProbe() {
  const l = useLocation();
  location = l.search;
  return null;
}
function renderPage(url = '/my-actions') {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={[url]}>
        <MyActionsPage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}
const lastQuery = () => queries[queries.length - 1];

beforeEach(() => {
  rows = [];
  total = 0;
  queries.length = 0;
  vi.clearAllMocks();
  exportActionsMock.mockResolvedValue({ blob: new Blob(), filename: 'f.csv', rowCount: 1, skipped: 0, exportId: 'x' });
});

describe('MyActionsPage — revamp', () => {
  it('builds one query from the URL: all directions, profiles, facets, search, paging, includes', () => {
    total = 100;
    renderPage('/my-actions?profiles=p1,p2&status=accepted&f_seeker.educationCategory=12th&q=meera&page=2&per=25');
    expect(lastQuery()).toMatchObject({
      ownership_role: 'all',
      item_ids: ['p1', 'p2'],
      action_status: ['accepted'],
      facets: [{ domain: 'seeker', field: 'educationCategory', values: ['12th'] }],
      q: 'meera',
      limit: 25,
      offset: 25,
      include: ['counts', 'counterparty_summary'],
    });
  });

  it('shows the counterparty, direction, match % and the needs-review strip with summary facts', () => {
    rows = [row('a1')];
    total = 1;
    renderPage();
    expect(screen.getByText('A***')).toBeInTheDocument();
    expect(screen.getAllByText('Received').length).toBeGreaterThan(0);
    expect(screen.getByText('★ 82%')).toBeInTheDocument();
    expect(screen.getByText('Needs your review')).toBeInTheDocument();
    expect(screen.getByText('Education')).toBeInTheDocument();
    expect(screen.getByText('12th')).toBeInTheDocument();
  });

  it('Accept on the review strip opens the status updater for that action', async () => {
    rows = [row('a1')];
    total = 1;
    renderPage();
    await userEvent.click(screen.getAllByRole('button', { name: 'Accept' })[0]);
    expect(statusUpdater).toHaveBeenCalledWith('a1', 'accepted');
  });

  it('removing a chip rewrites the URL and resets to page 1', async () => {
    total = 100;
    renderPage('/my-actions?status=accepted&page=3');
    await userEvent.click(screen.getByRole('button', { name: /Remove Status: Accepted|Remove Status/ }));
    await waitFor(() => expect(location).not.toContain('status='));
    expect(location).not.toContain('page=');
  });

  it('pages through results', async () => {
    rows = Array.from({ length: 10 }, (_, i) => row(`a${i}`, { action_status: 'accepted' }));
    total = 35;
    renderPage();
    expect(screen.getByText('Showing 1–10 of 35')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Next page' }));
    await waitFor(() => expect(lastQuery().offset).toBe(10));
  });

  it('bulk Accept sends only received pending rows to the bulk dialog', async () => {
    rows = [row('a1'), row('a2', { action_status: 'accepted' })];
    total = 2;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    await userEvent.click(within(bar).getByRole('button', { name: 'Accept (1)' }));
    expect(bulkDialog).toHaveBeenCalledWith(['a1'], 'accepted');
  });

  it('Export sends one request per counterparty type, only exportable statuses', async () => {
    rows = [
      row('a1', { action_status: 'accepted' }),
      row('a2', {
        action_status: 'completed',
        ownership_roles: ['initiated'],
        source_item_id: 'p1',
        source_item_domain: 'provider',
        target_item_id: 'sp1',
        target_item_domain: 'service_provider',
      }),
      row('a3'),
    ];
    total = 3;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    // Two counterparty types → a menu: one line per type, plus all files.
    await userEvent.click(screen.getByRole('button', { name: /^Export \(2\)/ }));
    expect(await screen.findByRole('menuitem', { name: 'Seekers (1)' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: 'Service Providers (1)' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'All — 2 files' }));
    await waitFor(() => expect(exportActionsMock).toHaveBeenCalledTimes(2));
    const bodies = exportActionsMock.mock.calls.map((c) => c[0].filters);
    expect(bodies.map((f) => [f.counterparty_domain, f.action_ids])).toEqual([
      ['seeker', ['a1']],
      ['service_provider', ['a2']],
    ]);
    expect(bodies[0].action_status).toEqual(['accepted', 'completed']);
  });
});

describe('MyActionsPage — back', () => {
  it('goes to the map view when the tab opened on My Actions (no in-app history)', async () => {
    renderPage('/my-actions');
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(location).toContain('view=map'));
  });
});

describe('MyActionsPage — sortable headers', () => {
  it('Distance and Match score headers sort; Updated toggles newest/oldest', async () => {
    rows = [row('a1', { action_status: 'accepted' })];
    total = 1;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /^Distance/ }));
    await waitFor(() => expect(lastQuery().sort).toBe('distance'));
    expect(screen.getByRole('columnheader', { name: /Distance/ })).toHaveAttribute('aria-sort', 'ascending');
    await userEvent.click(screen.getByRole('button', { name: /^Match score/ }));
    await waitFor(() => expect(lastQuery().sort).toBe('match_score'));
    await userEvent.click(screen.getByRole('button', { name: /^Updated/ }));
    await waitFor(() => expect(lastQuery().sort).toBe('recent'));
    await userEvent.click(screen.getByRole('button', { name: /^Updated/ }));
    await waitFor(() => expect(lastQuery().sort).toBe('oldest'));
  });

  it('Name is not sortable', () => {
    renderPage();
    expect(screen.queryByRole('button', { name: /^Name/ })).toBeNull();
  });
});
