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
    counterparty: { network: 'blue_dot', domain: 'seeker', item_type: 'profile_1.0', column_fields: { educationCategory: '12th' } },
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
  PageShell: (p: {
    children: React.ReactNode;
    onBack?: () => void;
    onActiveProfileChange?: (id: string) => void;
    onNetworkSelect?: (id: string) => void;
    onProfilesChanged?: () => void;
  }) => (
    <div>
      <button type="button" onClick={p.onBack}>
        Back
      </button>
      <button type="button" onClick={() => p.onActiveProfileChange?.('p2')}>
        sidebar-profile
      </button>
      <button type="button" onClick={() => p.onNetworkSelect?.('orange_dot')}>
        sidebar-network
      </button>
      <button type="button" onClick={() => p.onProfilesChanged?.()}>
        sidebar-profiles-changed
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
  BulkStatusDialog: (p: {
    open: boolean;
    actions: Action[];
    targetStatus: string;
    onSettled: (ok: number, total: number, failed: string[]) => void;
    onOpenChange: (open: boolean) => void;
  }) => {
    if (p.open) bulkDialog(p.actions.map((a) => a.action_id), p.targetStatus);
    return p.open ? (
      <div>
        <button type="button" onClick={() => p.onSettled(0, p.actions.length, p.actions.map((a) => a.action_id))}>
          bulk-settle-failed
        </button>
        <button type="button" onClick={() => p.onOpenChange(false)}>
          bulk-close
        </button>
      </div>
    ) : null;
  },
}));
vi.mock('@/components/actions/profile-card-modal', () => ({ ProfileCardModal: () => <div data-testid="profile-modal" /> }));
const toastMock = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', () => ({ toast: toastMock }));
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
  exportActionsMock.mockResolvedValue({ blob: new Blob(), filename: 'f.xlsx', rowCount: 1, skipped: 0, exportId: 'x' });
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
      include: ['counts', 'column_fields'],
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

describe('MyActionsPage — export paths', () => {
  const accepted = (id: string) => row(id, { action_status: 'accepted' });

  it('one counterparty type → "Export seekers (n)" sends the picked ids', async () => {
    rows = [accepted('a1'), accepted('a2')];
    total = 2;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export seekers (2)' }));
    await waitFor(() => expect(exportActionsMock).toHaveBeenCalledTimes(1));
    expect(exportActionsMock.mock.calls[0][0].filters).toMatchObject({ action_ids: ['a1', 'a2'], counterparty_domain: 'seeker' });
    await waitFor(() => expect(toastMock.success).toHaveBeenCalled());
  });

  it('"Select all N" exports by filter, one request per exportable counterparty type', async () => {
    rows = [accepted('a1')];
    total = 30;
    renderPage('/my-actions?q=asha');
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Select all 30' }));
    await userEvent.click(screen.getByRole('button', { name: /^Export \(2\)/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'All — 2 files' }));
    await waitFor(() => expect(exportActionsMock).toHaveBeenCalledTimes(2));
    const filters = exportActionsMock.mock.calls.map((c) => c[0].filters);
    expect(filters.map((f) => f.counterparty_domain)).toEqual(['seeker', 'service_provider']);
    expect(filters[0]).toMatchObject({ q: 'asha', action_status: ['accepted', 'completed'] });
    expect(filters[0].action_ids).toBeUndefined();
  });

  it('a failed export shows the mapped message; an empty one says so', async () => {
    const { ActionExportError } = await import('@/lib/action-export');
    rows = [accepted('a1')];
    total = 1;
    exportActionsMock.mockRejectedValueOnce(new ActionExportError('too big', 413, 'EXPORT_TOO_LARGE'));
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Export seekers (1)' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('actions.export_too_large'));
    exportActionsMock.mockResolvedValueOnce({ blob: new Blob(), filename: 'f.xlsx', rowCount: 0, skipped: 0 });
    await userEvent.click(screen.getByRole('button', { name: 'Export seekers (1)' }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('actions.export_nothing'));
  });

  it('row menu: Export profile sends that one action; View profile opens the profile', async () => {
    rows = [accepted('a1')];
    total = 1;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Export profile' }));
    await waitFor(() => expect(exportActionsMock).toHaveBeenCalledTimes(1));
    expect(exportActionsMock.mock.calls[0][0].filters).toMatchObject({ action_ids: ['a1'], counterparty_domain: 'seeker' });
    await userEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'View profile' }));
    expect(screen.getByTestId('profile-modal')).toBeInTheDocument();
  });
});

describe('MyActionsPage — views and columns', () => {
  it('a saved view rewrites direction and statuses in the URL', async () => {
    total = 5;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /^Views/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: /Needs my response/ }));
    await waitFor(() => expect(location).toContain('dir=received'));
    expect(location).toContain('status=created');
  });

  it('remembers hidden columns', async () => {
    localStorage.removeItem('my-actions-columns');
    rows = [row('a1')];
    total = 1;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /^Columns/ }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Distance' }));
    expect(JSON.parse(localStorage.getItem('my-actions-columns') ?? '{}')).toMatchObject({ distance: false });
  });
});

describe('MyActionsPage — sidebar, chips and bulk settle', () => {
  it('a sidebar profile switch scopes the list to that profile; a network switch drops profiles', async () => {
    total = 5;
    renderPage('/my-actions?profiles=p1');
    await userEvent.click(screen.getByRole('button', { name: 'sidebar-profile' }));
    await waitFor(() => expect(lastQuery().item_ids).toEqual(['p2']));
    await userEvent.click(screen.getByRole('button', { name: 'sidebar-network' }));
    await waitFor(() => expect(location).toContain('network=orange_dot'));
    expect(location).not.toContain('profiles=');
    await userEvent.click(screen.getByRole('button', { name: 'sidebar-profiles-changed' }));
  });

  it('every chip kind can be removed, and Clear all resets', async () => {
    total = 5;
    renderPage('/my-actions?profiles=p1&dir=sent&type=apply&q=asha&f_seeker.educationCategory=12th');
    for (const name of [/Remove Search/, /Remove Profile/, /Remove Direction/, /Remove Action type/, /Remove Education/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    await userEvent.click(screen.getByRole('button', { name: /Remove Education/ }));
    await waitFor(() => expect(location).not.toContain('f_seeker'));
    await userEvent.click(screen.getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(location).not.toContain('dir='));
    expect(location).not.toContain('q=');
  });

  it('a partly failed bulk keeps only the failed rows selected', async () => {
    rows = [row('a1'), row('a2')];
    total = 2;
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    await userEvent.click(screen.getByRole('button', { name: 'Reject (2)' }));
    expect(bulkDialog).toHaveBeenCalledWith(['a1', 'a2'], 'rejected');
    await userEvent.click(screen.getByRole('button', { name: 'bulk-settle-failed' }));
    await userEvent.click(screen.getByRole('button', { name: 'bulk-close' }));
    expect(screen.getByText('2 selected')).toBeInTheDocument();
  });
});
