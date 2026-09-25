import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import type { CardSelection } from '@/hooks/use-card-selection';

// #771 — My Actions page wiring for bulk export: config-driven visibility,
// selection kept across tabs, per-counterparty downloads and the request sent.
// ActionList is stubbed (its own tests cover rendering); the stub exposes the
// export props and the page-owned selection so the page wiring is driven
// directly.

const statusEvent = { type: 'object', properties: { status: { type: 'string' } } };
let revealStatuses = ['accepted', 'completed'];
const inter = (from: string, to: string, requester?: string[]) => ({
  from_domain: from,
  to_domain: to,
  requirement_schema: { type: 'object' },
  event_schema: statusEvent,
  reveals_pii_on_status: revealStatuses,
  ...(requester ? { export: { requester_domains: requester } } : {}),
});

function buildNetwork(): DotNetworkSchema {
  return {
    id: 'blue_dot',
    display_name: 'Blue Dots',
    description: 'test',
    schema_standard: '1.0',
    domains: [
      { id: 'seeker', label: 'Seeker', description: 'Seeker' },
      { id: 'provider', label: 'Provider', description: 'Provider' },
      { id: 'service_provider', label: 'Service Provider', description: 'SP' },
    ],
    actions: {
      connect: {
        description: '',
        interactions: [
          inter('seeker', 'service_provider', ['service_provider']),
          inter('service_provider', 'seeker', ['service_provider']),
          inter('provider', 'service_provider', ['provider', 'service_provider']),
          inter('service_provider', 'provider', ['provider', 'service_provider']),
        ],
      },
    },
  } as unknown as DotNetworkSchema;
}

let network = buildNetwork();
let myDomain = 'service_provider';
const liveItem = (): Item =>
  ({
    item_id: 'item-me',
    item_network: 'blue_dot',
    item_domain: myDomain,
    item_type: 'profile_1.0',
    item_state: {},
    item_locations: [],
    lifecycle_status: 'live',
    created_at: '',
    updated_at: '',
  }) as unknown as Item;

const act_ = (
  id: string,
  role: 'initiated' | 'received',
  counterparty: string,
  status = 'accepted',
) => ({
  action_id: id,
  action_status: status,
  ownership_roles: [role],
  source_item_domain: role === 'received' ? counterparty : myDomain,
  target_item_domain: role === 'received' ? myDomain : counterparty,
});

let initiated: ReturnType<typeof act_>[] = [];
let received: ReturnType<typeof act_>[] = [];
const page = (actions: unknown[]) => ({
  data: { pages: [{ actions, meta: { total: actions.length, limit: 20, offset: 0 } }] },
  isLoading: false,
  isError: false,
  error: null,
  isRefetching: false,
  hasNextPage: false,
  isFetchingNextPage: false,
  fetchNextPage: vi.fn(),
  refetch: vi.fn(),
});

vi.mock('@/hooks/use-actions', () => ({
  useInitiatedActions: () => page(initiated),
  useReceivedActions: () => page(received),
}));
vi.mock('@/hooks/use-my-items', () => ({
  useMyItems: () => ({ data: [liveItem()], isLoading: false, isFetched: true }),
}));
vi.mock('@/hooks/use-active-profile', () => ({
  useActiveProfile: () => ({ activeProfileId: 'item-me', setActiveProfile: vi.fn(), activeItem: liveItem() }),
}));
vi.mock('@/hooks/use-network-config', () => ({
  useNetworkConfigs: () => ({ data: [network], isLoading: false, isError: false }),
  useResolvedNetwork: () => ({ data: network, isLoading: false, isError: false, error: null }),
}));
vi.mock('@/lib/served-binding', () => ({ getServedScope: () => null }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) =>
      opts && typeof opts === 'object' ? `${key}:${JSON.stringify(opts)}` : key,
  }),
}));
vi.mock('@/components/layout/page-shell', () => ({
  PageShell: (p: { children: React.ReactNode }) => <div>{p.children}</div>,
}));
vi.mock('@/components/actions/action-status-updater', () => ({ ActionStatusUpdater: () => null }));
vi.mock('@/components/actions/bulk-status-dialog', () => ({ BulkStatusDialog: () => null }));
vi.mock('@/components/actions/action-filters-sheet', () => ({ ActionFiltersSheet: () => null }));

const toastMock = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', () => ({ toast: toastMock }));

const exportActionsMock = vi.fn();
const saveBlobMock = vi.fn();
vi.mock('@/lib/action-export', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/action-export')>();
  return {
    ...real,
    exportActions: (...a: unknown[]) => exportActionsMock(...a),
    saveBlob: (...a: unknown[]) => saveBlobMock(...a),
  };
});

// Stub ActionList: exposes the export props and hands the selection out.
let selectionRef: CardSelection | null = null;
let onTabChangeRef: ((t: 'initiated' | 'received') => void) | null = null;
vi.mock('@/components/actions/action-list', () => ({
  ActionList: (props: {
    selection: CardSelection;
    onTabChange: (t: 'initiated' | 'received') => void;
    exportEnabled?: boolean;
    exportControls?: React.ReactNode;
    selectionSplit?: { sent: number; received: number };
  }) => {
    selectionRef = props.selection;
    onTabChangeRef = props.onTabChange;
    return (
      <div>
        <span data-testid="export-enabled">{String(!!props.exportEnabled)}</span>
        <span data-testid="split">{JSON.stringify(props.selectionSplit)}</span>
        {props.exportEnabled && props.exportControls}
      </div>
    );
  },
}));

const { MyActionsPage } = await import('@/pages/my-actions-page');

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/my-actions']}>
        <MyActionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const select = (id: string, group = 'accepted') =>
  act(() => {
    selectionRef!.enterSelect();
    selectionRef!.toggle(id, group);
  });

beforeEach(() => {
  revealStatuses = ['accepted', 'completed'];
  network = buildNetwork();
  myDomain = 'service_provider';
  initiated = [];
  received = [];
  selectionRef = null;
  exportActionsMock.mockReset();
  saveBlobMock.mockReset();
  toastMock.success.mockReset();
  toastMock.error.mockReset();
});

describe('MyActionsPage — bulk export', () => {
  it('no export entitlement (seeker) → no download control', () => {
    myDomain = 'seeker';
    renderPage();
    expect(screen.getByTestId('export-enabled')).toHaveTextContent('false');
    expect(screen.queryByRole('button', { name: /export_download/ })).not.toBeInTheDocument();
  });

  it('entitled → a disabled Download until something is selected', () => {
    renderPage();
    expect(screen.getByTestId('export-enabled')).toHaveTextContent('true');
    expect(screen.getByRole('button', { name: /actions\.export_download/ })).toBeDisabled();
  });

  it('keeps an accepted selection across a tab switch, split by tab', async () => {
    initiated = [act_('s1', 'initiated', 'seeker')];
    received = [act_('r1', 'received', 'seeker')];
    renderPage();
    await select('r1');
    act(() => onTabChangeRef!('initiated'));
    await act(async () => selectionRef!.toggle('s1', 'accepted'));
    expect(screen.getByTestId('split')).toHaveTextContent('{"sent":1,"received":1}');
  });

  it('a pending selection still clears on tab switch', async () => {
    received = [act_('r1', 'received', 'seeker', 'created')];
    renderPage();
    await select('r1', 'pending');
    act(() => onTabChangeRef!('initiated'));
    expect(selectionRef!.selected.size).toBe(0);
  });

  it('mixed counterparties → one button per type; each sends its own ids + domain', async () => {
    received = [act_('r1', 'received', 'seeker'), act_('r2', 'received', 'provider')];
    exportActionsMock.mockResolvedValue({ blob: new Blob(['x']), filename: 'f.csv', exportId: 'e', rowCount: 1, skipped: 0 });
    const user = userEvent.setup();
    renderPage();
    await select('r1');
    await act(async () => selectionRef!.toggle('r2', 'accepted'));

    const seekersBtn = screen.getByRole('button', { name: /export_download_type.*Seekers/ });
    expect(screen.getByRole('button', { name: /export_download_type.*Providers/ })).toBeEnabled();
    await user.click(seekersBtn);

    await waitFor(() => expect(exportActionsMock).toHaveBeenCalledTimes(1));
    expect(exportActionsMock).toHaveBeenCalledWith({
      filters: {
        item_id: 'item-me',
        ownership_role: 'all',
        action_ids: ['r1'],
        // From config (reveals_pii_on_status), not hardcoded.
        action_status: ['accepted', 'completed'],
        counterparty_domain: 'seeker',
      },
      projection: { fields: '*' },
      format: 'csv',
    });
    await waitFor(() => expect(saveBlobMock).toHaveBeenCalledWith(expect.any(Blob), 'f.csv'));
    expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('actions.export_done'));
  });

  it('reports skipped rows, and saves nothing when zero rows came back', async () => {
    received = [act_('r1', 'received', 'seeker')];
    const user = userEvent.setup();
    renderPage();
    await select('r1');

    exportActionsMock.mockResolvedValueOnce({ blob: new Blob([]), filename: 'f.csv', exportId: 'e', rowCount: 1, skipped: 2 });
    await user.click(screen.getByRole('button', { name: /export_download_count/ }));
    await waitFor(() => expect(toastMock.success).toHaveBeenCalledWith(expect.stringContaining('export_done_skipped')));

    exportActionsMock.mockResolvedValueOnce({ blob: new Blob([]), filename: 'f.csv', exportId: 'e', rowCount: 0, skipped: 1 });
    saveBlobMock.mockClear();
    await user.click(screen.getByRole('button', { name: /export_download_count/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('actions.export_nothing'));
    expect(saveBlobMock).not.toHaveBeenCalled();
  });

  it('maps a 413 to the too-large message', async () => {
    const { ActionExportError } = await import('@/lib/action-export');
    received = [act_('r1', 'received', 'seeker')];
    exportActionsMock.mockImplementation(async () => {
      throw new ActionExportError('too many', 413, 'EXPORT_TOO_LARGE');
    });
    const user = userEvent.setup();
    renderPage();
    await select('r1');
    await user.click(screen.getByRole('button', { name: /export_download_count/ }));
    await waitFor(() => expect(toastMock.error).toHaveBeenCalledWith('actions.export_too_large'));
  });

  it('completed engagements are exportable alongside accepted ones', async () => {
    received = [act_('r1', 'received', 'seeker'), act_('r2', 'received', 'seeker', 'completed')];
    exportActionsMock.mockResolvedValue({ blob: new Blob(['x']), filename: 'f.csv', exportId: 'e', rowCount: 2, skipped: 0 });
    const user = userEvent.setup();
    renderPage();
    await select('r1');
    await act(async () => selectionRef!.toggle('r2', 'accepted'));
    await user.click(screen.getByRole('button', { name: /export_download_count/ }));
    await waitFor(() => expect(exportActionsMock).toHaveBeenCalledTimes(1));
    const body = exportActionsMock.mock.calls[0][0] as { filters: { action_ids: string[]; action_status: string[] } };
    expect(body.filters.action_ids).toEqual(['r1', 'r2']);
    expect(body.filters.action_status).toEqual(['accepted', 'completed']);
  });

  it('a network that reveals only on accepted never exports completed', async () => {
    revealStatuses = ['accepted'];
    network = buildNetwork();
    received = [act_('r1', 'received', 'seeker', 'completed')];
    renderPage();
    await select('r1');
    // Selected, but not exportable → the only control is the disabled Download.
    expect(screen.getByRole('button', { name: /actions\.export_download$/ })).toBeDisabled();
  });
});
