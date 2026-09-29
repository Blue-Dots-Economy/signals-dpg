import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as React from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Action } from '@/lib/action-api';
import { COLUMN_IDS, type ColumnId } from '../my-actions-toolbar';
import { ActionsTable, type BulkCommand } from '../actions-table';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallbackOrOpts?: unknown, opts?: Record<string, unknown>) => {
      const fallback = typeof fallbackOrOpts === 'string' ? fallbackOrOpts : key;
      const vars = (typeof fallbackOrOpts === 'object' ? fallbackOrOpts : opts) as Record<string, unknown> | undefined;
      return fallback.replace(/\{\{(\w+)\}\}/g, (_, k) => String(vars?.[k] ?? ''));
    },
  }),
}));
let mobile = false;
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => mobile }));

const row = (id: string, over: Partial<Action> = {}): Action =>
  ({
    action_id: id,
    action_type: 'apply',
    action_status: 'created',
    ownership_roles: ['received'],
    source_item_id: `s-${id}`,
    source_item_network: 'n',
    source_item_domain: 'seeker',
    source_item_type: 't',
    source_item_name: 'A***',
    target_item_id: 'p1',
    target_item_network: 'n',
    target_item_domain: 'provider',
    target_item_type: 't',
    target_item_name: 'ABC ltd',
    updated_at: '2026-09-01T09:00:00Z',
    created_at: '2026-09-01T09:00:00Z',
    requirements_snapshot: {},
    match_score: 7.5,
    distance_m: 1200,
    counterparty: { network: 'n', domain: 'seeker', item_type: 't', column_fields: { gender: 'Female', langs: ['Hindi', 'English'] } },
    ...over,
  }) as unknown as Action;

const columns = Object.fromEntries(COLUMN_IDS.map((c) => [c, true])) as Record<ColumnId, boolean>;
const handlers = {
  onPage: vi.fn(),
  onPer: vi.fn(),
  onSort: vi.fn(),
  onRetry: vi.fn(),
  onToggle: vi.fn(),
  onTogglePage: vi.fn(),
  onSelectAll: vi.fn(),
  onClearSelection: vi.fn(),
  onCommand: vi.fn(),
};

function renderTable(over: Partial<React.ComponentProps<typeof ActionsTable>> = {}) {
  return render(
    <ActionsTable
      rows={[row('a1')]}
      total={1}
      page={1}
      per={10}
      columns={columns}
      sort="recent"
      isLoading={false}
      isError={false}
      pendingStatuses={['created']}
      exportStatuses={['accepted', 'completed']}
      canExport
      domainLabel={(d) => (d === 'seeker' ? 'Seeker' : 'Provider')}
      profileLabel={() => 'ABC ltd'}
      fieldLabel={(_d, f) => (f === 'gender' ? 'Gender' : 'Languages')}
      statusLabel={(s) => s}
      selected={new Set()}
      bulkCommands={[]}
      {...handlers}
      {...over}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mobile = false;
});

describe('ActionsTable — states', () => {
  it('shows skeletons while loading', () => {
    const { container } = renderTable({ isLoading: true });
    expect(container.querySelectorAll('tbody tr').length).toBeGreaterThan(0);
    expect(screen.queryByText('A***')).toBeNull();
  });

  it('offers a retry on error', async () => {
    renderTable({ isError: true });
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetry).toHaveBeenCalled();
  });

  it('shows the first-use message and its call to action when given', async () => {
    const onClick = vi.fn();
    renderTable({
      rows: [],
      total: 0,
      emptyState: { title: 'No actions yet', body: 'Apply or connect on the map.', action: { label: 'Go to the map', onClick } },
    });
    expect(screen.getByText('No actions yet')).toBeInTheDocument();
    expect(screen.queryByText('No actions match')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Go to the map' }));
    expect(onClick).toHaveBeenCalled();
  });

  it('explains an empty result', () => {
    renderTable({ rows: [], total: 0 });
    expect(screen.getByText('No actions match')).toBeInTheDocument();
    expect(screen.getByText('0 results')).toBeInTheDocument();
  });
});

describe('ActionsTable — rows', () => {
  it('renders a received pending row with its review strip and summary facts', async () => {
    renderTable();
    expect(screen.getByText('A***')).toBeInTheDocument();
    expect(screen.getByText('★ 75%')).toBeInTheDocument();
    expect(screen.getByText('1.2 km')).toBeInTheDocument();
    expect(screen.getByText('Needs your review')).toBeInTheDocument();
    expect(screen.getByText('Hindi, English')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reject' }));
    expect(handlers.onCommand).toHaveBeenCalledWith(expect.objectContaining({ action_id: 'a1' }), 'rejected');
    await userEvent.click(screen.getByRole('button', { name: 'View profile' }));
    expect(handlers.onCommand).toHaveBeenLastCalledWith(expect.anything(), 'view_profile');
  });

  it('shows "Not scored" and no distance when absent', () => {
    renderTable({ rows: [row('a1', { match_score: null, distance_m: null, action_status: 'accepted' })] });
    expect(screen.getByText('Not scored')).toBeInTheDocument();
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText('Needs your review')).toBeNull();
  });

  it('row menu: sent pending → Withdraw; received accepted → Mark complete + Export profile', async () => {
    renderTable({
      rows: [
        row('s1', { ownership_roles: ['initiated'], action_type: 'connect' }),
        row('r1', { action_status: 'accepted' }),
      ],
      total: 2,
    });
    expect(screen.getByText('You invited to connect')).toBeInTheDocument();
    const menus = screen.getAllByRole('button', { name: 'More actions' });
    await userEvent.click(menus[0]);
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Withdraw' }));
    expect(handlers.onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ action_id: 's1' }), 'cancelled');
    await userEvent.click(menus[1]);
    expect(await screen.findByRole('menuitem', { name: 'Mark complete' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Export profile' }));
    expect(handlers.onCommand).toHaveBeenLastCalledWith(expect.objectContaining({ action_id: 'r1' }), 'export');
  });

  it('hides every checkbox when nothing can be selected', () => {
    renderTable({ rows: [row('a1', { ownership_roles: ['initiated'] })], selectable: false });
    expect(screen.queryByRole('button', { name: 'Select page' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Select A\*\*\*/ })).toBeNull();
  });

  it('selects a row and the page', async () => {
    renderTable({ rows: [row('a1'), row('a2')], total: 2 });
    await userEvent.click(screen.getAllByRole('button', { name: /^Select A\*\*\*/ })[0]);
    expect(handlers.onToggle).toHaveBeenCalledWith('a1');
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    expect(handlers.onTogglePage).toHaveBeenCalledWith(['a1', 'a2'], true);
  });
});

describe('ActionsTable — selection bar', () => {
  const exportSeekers: BulkCommand = { id: 'export:seeker', label: 'Export seekers', count: 3, tone: 'primary', onClick: vi.fn() };
  const exportAll: BulkCommand = { id: 'export:sp', label: 'Export service providers', count: 1, hideCount: true, tone: 'primary', onClick: vi.fn() };


  it('shows only applicable commands, the note, select-all and clear', async () => {
    const accept: BulkCommand = { id: 'accept', label: 'Accept', count: 1, tone: 'accept', onClick: vi.fn() };
    const reject: BulkCommand = { id: 'reject', label: 'Reject', count: 0, tone: 'reject', onClick: vi.fn() };
    renderTable({
      rows: [row('a1'), row('a2')],
      total: 20,
      selected: new Set(['a1']),
      bulkCommands: [accept, reject, exportSeekers, exportAll],
      selectionNoteDetail: '1 not exportable — only accepted or completed',
      selectionNote: '1 not exportable',
    });
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(within(bar).getByText('1 selected')).toBeInTheDocument();
    expect(within(bar).queryByRole('button', { name: /^Reject/ })).toBeNull();
    expect(within(bar).getByText(/1 not exportable/)).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Accept (1)' }));
    expect(accept.onClick).toHaveBeenCalled();
    await userEvent.click(within(bar).getByRole('button', { name: 'Export seekers (3)' }));
    expect(exportSeekers.onClick).toHaveBeenCalled();
    // A count the page cannot know is left off the label.
    expect(within(bar).getByRole('button', { name: 'Export service providers' })).toBeInTheDocument();
    expect(within(bar).getByText(/1 not exportable/)).toHaveAttribute('title', '1 not exportable — only accepted or completed');
    await userEvent.click(within(bar).getByRole('button', { name: 'Select all 20' }));
    expect(handlers.onSelectAll).toHaveBeenCalled();
    await userEvent.click(within(bar).getByRole('button', { name: 'Clear selection' }));
    expect(handlers.onClearSelection).toHaveBeenCalled();
  });
});

describe('ActionsTable — pagination', () => {
  it('pages, jumps and changes page size', async () => {
    renderTable({ total: 95, page: 5 });
    expect(screen.getByText('Showing 41–50 of 95')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Previous page' }));
    expect(handlers.onPage).toHaveBeenCalledWith(4);
    await userEvent.click(screen.getByRole('button', { name: '10' }));
    expect(handlers.onPage).toHaveBeenCalledWith(10);
    await userEvent.selectOptions(screen.getByRole('combobox'), '25');
    expect(handlers.onPer).toHaveBeenCalledWith(25);
  });
});

describe('ActionsTable — phones', () => {
  beforeEach(() => {
    mobile = true;
  });

  it('renders one card per action with the review strip and actions', async () => {
    renderTable({ rows: [row('a1'), row('a2', { action_status: 'accepted', ownership_roles: ['initiated'] })], total: 2 });
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Needs your review')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }));
    expect(handlers.onCommand).toHaveBeenCalledWith(expect.objectContaining({ action_id: 'a1' }), 'accepted');
    await userEvent.click(screen.getByRole('button', { name: 'Select page' }));
    expect(handlers.onTogglePage).toHaveBeenCalledWith(['a1', 'a2'], true);
  });

  it('phone cards drop the checkboxes when nothing can be selected', () => {
    renderTable({ rows: [row('a1')], selectable: false });
    expect(screen.queryByRole('button', { name: 'Select page' })).toBeNull();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('phone states: loading, error, empty', async () => {
    const { rerender } = renderTable({ isLoading: true });
    expect(screen.queryByRole('listitem')).toBeNull();
    rerender(
      <ActionsTable
        rows={[]}
        total={0}
        page={1}
        per={10}
        columns={columns}
        sort="recent"
        isLoading={false}
        isError
        pendingStatuses={[]}
        exportStatuses={[]}
        canExport={false}
        domainLabel={(d) => d}
        profileLabel={() => ''}
        fieldLabel={(_d, f) => f}
        statusLabel={(s) => s}
        selected={new Set()}
        bulkCommands={[]}
        {...handlers}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(handlers.onRetry).toHaveBeenCalled();
  });

  it('phone empty state', () => {
    renderTable({ rows: [], total: 0 });
    expect(screen.getByText('No actions match')).toBeInTheDocument();
  });
});
