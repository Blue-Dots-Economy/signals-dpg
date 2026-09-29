import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EMPTY_FILTER, type MyActionsFilter } from '@/lib/my-actions-view';
import { COLUMN_IDS, MyActionsToolbar, type ColumnId } from '../my-actions-toolbar';

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

const allColumns = Object.fromEntries(COLUMN_IDS.map((c) => [c, true])) as Record<ColumnId, boolean>;
const onChange = vi.fn();
const onToggleColumn = vi.fn();
const onSavedView = vi.fn();
const onRefresh = vi.fn();

function renderToolbar(filter: Partial<MyActionsFilter> = {}) {
  return render(
    <MyActionsToolbar
      filter={{ ...EMPTY_FILTER, ...filter }}
      onChange={onChange}
      profiles={[
        { id: 'p1', label: 'ABC ltd' },
        { id: 'p2', label: 'Test Nest' },
      ]}
      statusOptions={[
        { id: 'pending', statuses: ['created', 'invited'], label: 'Pending' },
        { id: 'accepted', statuses: ['accepted'], label: 'Accepted' },
      ]}
      types={['apply', 'connect']}
      facetGroups={[
        { domain: 'seeker', domainLabel: 'Seekers', fields: [{ key: 'gender', label: 'Gender', options: ['Male', 'Female'], isArray: false }] },
      ]}
      columns={allColumns}
      onToggleColumn={onToggleColumn}
      savedView="all"
      counts={{ all: 9, needs_response: 2, ready_to_export: 4, sent: 3 }}
      onSavedView={onSavedView}
      onRefresh={onRefresh}
    />,
  );
}
const last = (): MyActionsFilter => onChange.mock.calls.at(-1)?.[0];

beforeEach(() => {
  vi.clearAllMocks();
  mobile = false;
});

describe('MyActionsToolbar', () => {
  it('debounces search into the filter and resets the page', async () => {
    renderToolbar({ page: 3 });
    await userEvent.type(screen.getByPlaceholderText('Search name or job…'), 'asha');
    expect(onChange).not.toHaveBeenCalled();
    await waitFor(() => expect(last()).toMatchObject({ q: 'asha', page: 1 }), { timeout: 1500 });
  });

  it('clears the search box', async () => {
    renderToolbar({ q: 'asha' });
    await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(last()).toMatchObject({ q: '' }), { timeout: 1500 });
  });

  it('picks profiles, and "All profiles" clears them', async () => {
    renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: /^Profiles/ }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Test Nest' }));
    expect(last().profiles).toEqual(['p2']);
    await userEvent.click(screen.getByRole('menuitemcheckbox', { name: 'All profiles' }));
    expect(last().profiles).toEqual([]);
  });

  it('filters by direction, status, action type and a schema field', async () => {
    renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    await userEvent.click(await screen.findByLabelText('Received'));
    expect(last().direction).toBe('received');
    await userEvent.click(screen.getByLabelText('Pending'));
    expect(last().statuses).toEqual(['created', 'invited']);
    await userEvent.click(screen.getByLabelText('Connect'));
    expect(last().types).toEqual(['connect']);
    await userEvent.click(screen.getByLabelText('Female'));
    expect(last().facets).toEqual([{ domain: 'seeker', field: 'gender', values: ['Female'] }]);
  });

  it('shows grouped pending statuses as one option, ticked only when all are on', async () => {
    renderToolbar({ statuses: ['created'] });
    await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    const pending = await screen.findByLabelText('Pending');
    expect(pending).not.toBeChecked();
    await userEvent.click(pending);
    expect(last().statuses).toEqual(['created', 'invited']);
  });

  it('unticks the whole pending group and counts it as one filter', async () => {
    renderToolbar({ statuses: ['created', 'invited'] });
    expect(screen.getByRole('button', { name: /^Filter\s*1/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    await userEvent.click(await screen.findByLabelText('Pending'));
    expect(last().statuses).toEqual([]);
  });

  it('removes a schema field value when unticked, and clears every filter', async () => {
    renderToolbar({ facets: [{ domain: 'seeker', field: 'gender', values: ['Female'] }], statuses: ['accepted'] });
    await userEvent.click(screen.getByRole('button', { name: /^Filter/ }));
    await userEvent.click(await screen.findByLabelText('Female'));
    expect(last().facets).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(last()).toMatchObject({ statuses: [], types: [], direction: 'all', facets: [] });
  });

  it('sorts, toggles columns and applies a saved view', async () => {
    renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: /^Sort/ }));
    await userEvent.click(await screen.findByRole('menuitemradio', { name: 'Distance ↑' }));
    expect(last().sort).toBe('distance');

    await userEvent.click(screen.getByRole('button', { name: /^Columns/ }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Distance' }));
    expect(onToggleColumn).toHaveBeenCalledWith('distance');
    await userEvent.keyboard('{Escape}');

    await userEvent.click(screen.getByRole('button', { name: /^Views/ }));
    expect(await screen.findByRole('menuitem', { name: /Needs my response\s*2/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: /Ready to export/ }));
    expect(onSavedView).toHaveBeenCalledWith('ready_to_export');
  });

  it('refreshes', async () => {
    renderToolbar();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(onRefresh).toHaveBeenCalled();
  });

  it('hides the Columns control on phones', () => {
    mobile = true;
    renderToolbar();
    expect(screen.queryByRole('button', { name: /^Columns/ })).toBeNull();
  });
});
