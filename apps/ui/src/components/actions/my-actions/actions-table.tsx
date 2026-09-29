import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { format, isToday, isYesterday } from 'date-fns';
import {
  AlertCircle,
  ArrowDownLeft,
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { getStatusStyle } from '@/components/actions/action-card';
import { useIsMobile } from '@/hooks/use-mobile';
import type { Action } from '@/lib/action-api';
import {
  needsResponse,
  pageList,
  PAGE_SIZES,
  sidesOf,
  type ActionSides,
  type ActionSortKey,
} from '@/lib/my-actions-view';
import type { ColumnId } from './my-actions-toolbar';

export type RowCommand = 'accepted' | 'rejected' | 'cancelled' | 'completed' | 'view_profile' | 'export';

export interface BulkCommand {
  id: string;
  label: string;
  count: number;
  tone: 'accept' | 'reject' | 'primary' | 'neutral';
  onClick: () => void;
  /** Show the label without "(count)" — for a count the page cannot know yet. */
  hideCount?: boolean;
}

interface Labels {
  /** Label of the counterparty's domain, e.g. "Seeker". */
  domainLabel: (domain: string) => string;
  /** Label of one of the caller's own profiles, by item id. */
  profileLabel: (itemId: string) => string;
  /** Title of a counterparty schema field, e.g. "Education". */
  fieldLabel: (domain: string, field: string) => string;
  statusLabel: (status: string) => string;
}

interface ActionsTableProps extends Labels {
  rows: Action[];
  total: number;
  page: number;
  per: number;
  onPage: (page: number) => void;
  onPer: (per: number) => void;
  columns: Record<ColumnId, boolean>;
  /** Current sort; sortable headers show it and change it. */
  sort: ActionSortKey;
  onSort: (sort: ActionSortKey) => void;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  pendingStatuses: readonly string[];
  exportStatuses: readonly string[];
  canExport: boolean;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onTogglePage: (ids: string[], on: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  bulkCommands: BulkCommand[];
  /** Why some of the selection is left out of an action, e.g. not exportable. */
  selectionNote?: string;
  /** The longer explanation of `selectionNote`, shown on hover. */
  selectionNoteDetail?: string;
  onCommand: (action: Action, command: RowCommand) => void;
  /**
   * What to say when there are no rows. Defaults to the "no match — loosen
   * the filters" copy; the page passes a first-use message when nothing is
   * filtered and the caller simply has no actions yet.
   */
  emptyState?: EmptyStateCopy;
  /**
   * Whether rows can be selected. False when no bulk command could ever apply
   * to this caller (e.g. a seeker who cannot export and has nothing to answer):
   * checkboxes that lead nowhere are hidden. Default true.
   */
  selectable?: boolean;
}

export interface EmptyStateCopy {
  title: string;
  body: string;
  /** Optional call to action, e.g. "Go to the map". */
  action?: { label: string; onClick: () => void };
}

/** The no-rows message; used by the table and the phone card list. */
function EmptyMessage({ copy }: Readonly<{ copy: EmptyStateCopy | undefined }>) {
  const { t } = useTranslation();
  const title = copy?.title ?? t('my_actions.empty_title', 'No actions match');
  const body = copy?.body ?? t('my_actions.empty_body', 'Try removing a filter or clearing the search.');
  return (
    <div className="flex flex-col items-center gap-1">
      <p className="font-semibold">{title}</p>
      <p className="max-w-md text-sm text-muted-foreground">{body}</p>
      {copy?.action ? (
        <Button size="sm" className="mt-3" onClick={copy.action.onClick}>
          {copy.action.label}
        </Button>
      ) : null}
    </div>
  );
}

type Translate = (key: string, fallback: string, opts?: Record<string, unknown>) => string;

// Name is the one flexible column (it takes whatever width is left); every
// other column is sized to its content so it never hoards spare space.
const COLUMN_WIDTH: Record<ColumnId, number | undefined> = {
  action: 170,
  direction: 105,
  status: 115,
  profile: 140,
  match: 110,
  distance: 80,
  updated: 120,
};
const RIGHT_ALIGNED = new Set<ColumnId>(['match', 'distance', 'updated']);

/**
 * Headers that sort, and what a click selects. Only what the API can order
 * by: no name sort (ordering by a masked name leaks the hidden one) and no
 * status sort server-side.
 */
function headerSort(column: ColumnId, current: ActionSortKey): { next: ActionSortKey; active: boolean; arrow: string } | null {
  switch (column) {
    case 'updated':
      return {
        next: current === 'recent' ? 'oldest' : 'recent',
        active: current === 'recent' || current === 'oldest',
        arrow: current === 'oldest' ? '▲' : '▼',
      };
    case 'match':
      return { next: 'match_score', active: current === 'match_score', arrow: '▼' };
    case 'distance':
      return { next: 'distance', active: current === 'distance', arrow: '▲' };
    default:
      return null;
  }
}

function HeaderCell({
  column,
  label,
  sort,
  onSort,
}: Readonly<{ column: ColumnId; label: string; sort: ActionSortKey; onSort: (s: ActionSortKey) => void }>) {
  const right = RIGHT_ALIGNED.has(column);
  const s = headerSort(column, sort);
  if (!s) {
    return (
      <th scope="col" className={`whitespace-nowrap px-3 font-semibold ${right ? 'text-right' : ''}`}>
        {label}
      </th>
    );
  }
  let ariaSort: 'ascending' | 'descending' | undefined;
  if (s.active) ariaSort = s.arrow === '▲' ? 'ascending' : 'descending';
  return (
    <th scope="col" aria-sort={ariaSort} className={`whitespace-nowrap px-3 font-semibold ${right ? 'text-right' : ''}`}>
      <button
        type="button"
        onClick={() => onSort(s.next)}
        className={`inline-flex items-center gap-1 hover:text-foreground ${s.active ? 'text-primary' : ''}`}
      >
        {label}
        <span className={`text-[10px] ${s.active ? '' : 'opacity-0'}`} aria-hidden="true">
          {s.arrow}
        </span>
      </button>
    </th>
  );
}
const FLEX_MIN = 120;
const NAME_MIN = 170;

const toneClass: Record<BulkCommand['tone'], string> = {
  // Each tone restates its dark-mode colours: the outline variant sets its own
  // `dark:` border/background, which would otherwise win and grey these out.
  accept:
    'border-emerald-600 bg-emerald-600 text-white hover:bg-emerald-600/90 dark:border-emerald-600 dark:bg-emerald-600 dark:hover:bg-emerald-600/90 dark:hover:text-white',
  reject:
    'border-red-200 bg-background text-red-600 hover:bg-red-50 dark:border-red-500/40 dark:text-red-400 dark:hover:bg-red-500/10 dark:hover:text-red-300',
  primary:
    'border-primary bg-primary text-primary-foreground hover:bg-primary/90 dark:border-primary dark:bg-primary dark:hover:bg-primary/90 dark:hover:text-primary-foreground',
  neutral: 'bg-background',
};

function when(iso: string, t: Translate): string {
  const d = new Date(iso);
  const clock = format(d, 'h:mm a');
  if (isToday(d)) return `${t('my_actions.today', 'Today')}, ${clock}`;
  if (isYesterday(d)) return `${t('my_actions.yesterday', 'Yesterday')}, ${clock}`;
  return format(d, 'd MMM, h:mm a');
}

function SelectBox({
  on,
  partial = false,
  label,
  onClick,
}: Readonly<{ on: boolean; partial?: boolean; label: string; onClick: () => void }>) {
  const filled = on || partial;
  let mark: React.ReactNode = null;
  if (on) mark = '✓';
  else if (partial) mark = <span className="h-0.5 w-2 bg-white" />;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={on}
      onClick={onClick}
      className={`flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border-[1.5px] ${
        filled ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
      }`}
    >
      {mark}
    </button>
  );
}

/**
 * The My Actions table: one row per sent or received action, a "needs your
 * review" row under received pending ones (the counterparty's summary fields
 * plus Accept / Reject), a per-row menu, a bulk bar above and pagination
 * below. Presentational — every change is a callback.
 */
export function ActionsTable(props: Readonly<ActionsTableProps>) {
  const { t } = useTranslation();
  const { rows, selected, columns } = props;
  const selectable = props.selectable ?? true;

  const pageIds = rows.map((r) => r.action_id);
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && pageSelected === pageIds.length;
  const someOnPage = pageSelected > 0 && !allOnPage;

  const columnLabel: Record<ColumnId, string> = {
    action: t('my_actions.col_action', 'Action'),
    direction: t('my_actions.col_direction', 'Direction'),
    status: t('my_actions.col_status', 'Status'),
    profile: t('my_actions.col_profile', 'Profile'),
    match: t('my_actions.col_match', 'Match score'),
    distance: t('my_actions.col_distance', 'Distance'),
    updated: t('my_actions.col_updated', 'Updated'),
  };
  const visible = (Object.keys(COLUMN_WIDTH) as ColumnId[]).filter((c) => columns[c]);
  const colCount = visible.length + 3; // select + name + columns + menu
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
        {selectable && selected.size > 0 ? <SelectionBar {...props} /> : null}
        {selectable ? (
          <div className="flex items-center gap-3 border-b bg-muted/40 px-3 py-2 text-xs font-semibold text-muted-foreground">
            <SelectBox
              on={allOnPage}
              partial={someOnPage}
              label={t('my_actions.select_page', 'Select page')}
              onClick={() => props.onTogglePage(pageIds, !allOnPage)}
            />
            {t('my_actions.select_page', 'Select page')}
          </div>
        ) : null}
        <CardList {...props} />
        <Pagination {...props} />
      </div>
    );
  }
  const selectWidth = selectable ? 44 : 16;
  const minWidth =
    selectWidth + NAME_MIN + 56 + visible.reduce((n, c) => n + (COLUMN_WIDTH[c] ?? FLEX_MIN), 0);

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
      {selectable && selected.size > 0 ? <SelectionBar {...props} /> : null}

      <div className="overflow-x-auto">
        <table className="w-full table-fixed border-collapse text-sm" style={{ minWidth }}>
          <colgroup>
            <col style={{ width: selectWidth }} />
            <col style={{ minWidth: NAME_MIN }} />
            {visible.map((c) => (
              <col key={c} style={COLUMN_WIDTH[c] ? { width: COLUMN_WIDTH[c] } : undefined} />
            ))}
            <col style={{ width: 56 }} />
          </colgroup>
          <thead className="border-b bg-muted/40 text-left text-xs font-semibold text-muted-foreground">
            <tr className="h-10">
              <th scope="col" className="text-center">
                {selectable ? (
                  <span className="flex justify-center">
                    <SelectBox
                      on={allOnPage}
                      partial={someOnPage}
                      label={t('my_actions.select_page', 'Select page')}
                      onClick={() => props.onTogglePage(pageIds, !allOnPage)}
                    />
                  </span>
                ) : null}
              </th>
              <th scope="col" className="px-3 font-semibold">
                {t('my_actions.col_name', 'Name')}
              </th>
              {visible.map((c) => (
                <HeaderCell key={c} column={c} label={columnLabel[c]} sort={props.sort} onSort={props.onSort} />
              ))}
              <th scope="col">
                <span className="sr-only">{t('my_actions.more_actions', 'More actions')}</span>
              </th>
            </tr>
          </thead>
          <TableBody {...props} visible={visible} colCount={colCount} />
        </table>
      </div>

      <Pagination {...props} />
    </div>
  );
}

function SelectionBar(props: Readonly<ActionsTableProps>) {
  const { t } = useTranslation();
  const { selected, total } = props;
  // Only what applies to this selection — a button with nothing to act on is
  // left out rather than shown disabled.
  const commands = props.bulkCommands.filter((b) => b.count > 0);
  return (
    <section
      aria-label={t('my_actions.selection', 'Selection')}
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b bg-primary/5 px-4 py-2"
    >
      <span className="text-sm font-semibold text-foreground">
        {t('my_actions.n_selected', '{{count}} selected', { count: selected.size })}
      </span>
      <span className="text-xs text-muted-foreground">{t('my_actions.of_total', 'of {{total}}', { total })}</span>
      {selected.size < total ? (
        <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={props.onSelectAll}>
          {t('my_actions.select_all_n', 'Select all {{total}}', { total })}
        </button>
      ) : null}
      {/* Clear sits with the count, so the commands on the right can wrap
          without pushing it onto a line of its own. */}
      <Button
        variant="ghost"
        size="sm"
        onClick={props.onClearSelection}
        aria-label={t('my_actions.clear_selection', 'Clear selection')}
        className="h-7 gap-1 px-2 text-xs text-muted-foreground"
      >
        <X className="h-3.5 w-3.5" />
        {t('my_actions.clear', 'Clear')}
      </Button>
      {props.selectionNote ? (
        <span className="text-xs text-muted-foreground" title={props.selectionNoteDetail}>
          · {props.selectionNote}
        </span>
      ) : null}
      {/* The commands keep together on the right; when they do not fit they
          wrap as a group, still right-aligned. */}
      <div className="ml-auto flex flex-wrap justify-end gap-2">
        {commands.map((b) => (
          <Button key={b.id} size="sm" variant="outline" className={`h-8 ${toneClass[b.tone]}`} onClick={b.onClick}>
            {b.hideCount ? b.label : `${b.label} (${b.count})`}
          </Button>
        ))}
      </div>
    </section>
  );
}

function TableBody(props: Readonly<ActionsTableProps & { visible: ColumnId[]; colCount: number }>) {
  const { t } = useTranslation();
  const { rows, colCount } = props;

  if (props.isLoading) {
    const skeletons = Array.from({ length: Math.min(props.per, 5) }, (_, i) => `skeleton-${i}`);
    return (
      <tbody>
        {skeletons.map((key) => (
          <tr key={key} className="border-b">
            <td colSpan={colCount} className="px-4 py-3">
              <Skeleton className="h-6 w-full" />
            </td>
          </tr>
        ))}
      </tbody>
    );
  }
  if (props.isError || rows.length === 0) {
    return (
      <tbody>
        <tr>
          <td colSpan={colCount} className="px-6 py-14 text-center">
            {props.isError ? (
              <div className="flex flex-col items-center gap-3">
                <p className="font-semibold">{t('my_actions.load_failed', "Actions couldn't be loaded")}</p>
                <Button variant="outline" size="sm" onClick={props.onRetry}>
                  {t('my_actions.retry', 'Try again')}
                </Button>
              </div>
            ) : (
              <EmptyMessage copy={props.emptyState} />
            )}
          </td>
        </tr>
      </tbody>
    );
  }
  return (
    <tbody>
      {rows.map((a) => (
        <ActionRow
          key={a.action_id}
          action={a}
          visible={props.visible}
          colCount={colCount}
          selectable={props.selectable ?? true}
          selected={props.selected.has(a.action_id)}
          review={needsResponse(a, props.pendingStatuses)}
          exportable={props.canExport && props.exportStatuses.includes(a.action_status)}
          labels={props}
          onToggle={() => props.onToggle(a.action_id)}
          onCommand={(c) => props.onCommand(a, c)}
        />
      ))}
    </tbody>
  );
}

function Pagination(props: Readonly<ActionsTableProps>) {
  const { t } = useTranslation();
  const { total, page, per } = props;
  const pages = Math.max(1, Math.ceil(total / per));
  const range =
    total > 0
      ? t('my_actions.range', 'Showing {{from}}–{{to}} of {{total}}', {
          from: (page - 1) * per + 1,
          to: Math.min(page * per, total),
          total,
        })
      : t('my_actions.no_results', '0 results');
  let gap = 0;
  return (
    <div className="flex flex-wrap items-center gap-4 border-t px-4 py-2.5 text-sm text-muted-foreground">
      <label className="flex items-center gap-2">
        {t('my_actions.rows_per_page', 'Rows per page')}
        <select
          className="h-8 rounded-md border bg-background px-2 font-semibold text-foreground"
          value={per}
          onChange={(e) => props.onPer(Number(e.target.value))}
        >
          {PAGE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <span className="flex-1" />
      <span>{range}</span>
      <nav className="flex items-center gap-1" aria-label={t('my_actions.pagination', 'Pagination')}>
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page <= 1}
          onClick={() => props.onPage(page - 1)}
          aria-label={t('my_actions.prev_page', 'Previous page')}
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {pageList(page, pages).map((p) => {
          if (p === '…') {
            gap += 1;
            return (
              <span key={`gap-${gap}`} className="px-1">
                …
              </span>
            );
          }
          return (
            <Button
              key={p}
              variant={p === page ? 'default' : 'outline'}
              size="sm"
              className="h-8 min-w-8 px-2"
              aria-current={p === page ? 'page' : undefined}
              onClick={() => props.onPage(p)}
            >
              {p}
            </Button>
          );
        })}
        <Button
          variant="outline"
          size="icon"
          className="h-8 w-8"
          disabled={page >= pages}
          onClick={() => props.onPage(page + 1)}
          aria-label={t('my_actions.next_page', 'Next page')}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </nav>
    </div>
  );
}

// ─── Phone layout: one card per action ──────────────────────────────────────

function CardList(props: Readonly<ActionsTableProps>) {
  const { t } = useTranslation();
  if (props.isLoading) {
    return (
      <div className="flex flex-col gap-2 p-3">
        {['a', 'b', 'c'].map((k) => (
          <Skeleton key={k} className="h-20 w-full" />
        ))}
      </div>
    );
  }
  if (props.isError) {
    return (
      <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <p className="font-semibold">{t('my_actions.load_failed', "Actions couldn't be loaded")}</p>
        <Button variant="outline" size="sm" onClick={props.onRetry}>
          {t('my_actions.retry', 'Try again')}
        </Button>
      </div>
    );
  }
  if (props.rows.length === 0) {
    return (
      <div className="px-6 py-12 text-center">
        <EmptyMessage copy={props.emptyState} />
      </div>
    );
  }
  return (
    <ul className="flex flex-col">
      {props.rows.map((a) => (
        <ActionCard
          key={a.action_id}
          action={a}
          selectable={props.selectable ?? true}
          selected={props.selected.has(a.action_id)}
          review={needsResponse(a, props.pendingStatuses)}
          exportable={props.canExport && props.exportStatuses.includes(a.action_status)}
          labels={props}
          onToggle={() => props.onToggle(a.action_id)}
          onCommand={(c) => props.onCommand(a, c)}
        />
      ))}
    </ul>
  );
}

function ActionCard({
  action: a,
  selectable,
  selected,
  review,
  exportable,
  labels,
  onToggle,
  onCommand,
}: Readonly<Omit<ActionRowProps, 'visible' | 'colCount'>>) {
  const { t } = useTranslation();
  const sides = sidesOf(a);
  const hasName = !!sides.other.name && sides.other.name !== sides.other.itemId;
  const name = hasName ? sides.other.name! : labels.domainLabel(sides.other.domain);
  return (
    <li
      className={`flex gap-3 border-b px-3 py-3 ${selected ? 'bg-primary/5' : ''} ${
        review ? 'shadow-[inset_3px_0_0_theme(colors.amber.500)]' : ''
      }`}
    >
      {selectable ? (
        <div className="pt-1">
          <SelectBox on={selected} label={t('my_actions.select_row', 'Select {{name}}', { name })} onClick={onToggle} />
        </div>
      ) : null}
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate font-semibold" title={name}>
              {name}
            </p>
            <p className="text-xs text-muted-foreground">
              {labels.domainLabel(sides.other.domain)} · {labels.profileLabel(sides.mine.itemId)}
            </p>
          </div>
          <span className="shrink-0 text-xs text-muted-foreground">{when(a.updated_at, t)}</span>
        </div>
        <p className="text-sm">{actionText(a, sides, t)}</p>
        <div className="-mx-3 flex flex-wrap items-center gap-y-1">
          <DirectionCell received={sides.direction === 'received'} />
          <StatusCell status={a.action_status} label={labels.statusLabel(a.action_status)} />
          {a.match_score == null ? null : (
            <span className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground">
              ★ {Math.round(a.match_score * 10)}%
            </span>
          )}
          {a.distance_m == null ? null : (
            <span className="px-3 text-xs text-muted-foreground">{(a.distance_m / 1000).toFixed(1)} km</span>
          )}
        </div>
        {review ? <ReviewStrip action={a} sides={sides} labels={labels} onCommand={onCommand} /> : null}
      </div>
      <div>
        <RowMenu items={rowMenu(a, sides, review, exportable, t)} onCommand={onCommand} />
      </div>
    </li>
  );
}

// ─── One action ─────────────────────────────────────────────────────────────

interface ActionRowProps {
  action: Action;
  visible: ColumnId[];
  colCount: number;
  selectable: boolean;
  selected: boolean;
  review: boolean;
  exportable: boolean;
  labels: Labels;
  onToggle: () => void;
  onCommand: (c: RowCommand) => void;
}

const ACTION_TEXT: Record<string, [string, string]> = {
  'received:apply': ['my_actions.row_applied', 'Applied to your listing'],
  'received:connect': ['my_actions.row_wants_connect', 'Wants to connect'],
  'sent:apply': ['my_actions.row_you_applied', 'You applied'],
  'sent:connect': ['my_actions.row_you_invited', 'You invited to connect'],
};

function actionText(a: Action, sides: ActionSides, t: Translate): string {
  const kind = a.action_type === 'apply' ? 'apply' : 'connect';
  const [key, fallback] = ACTION_TEXT[`${sides.direction}:${kind}`];
  return t(key, fallback);
}

function rowMenu(
  a: Action,
  sides: ActionSides,
  review: boolean,
  exportable: boolean,
  t: Translate,
): Array<{ c: RowCommand; label: string; danger?: boolean }> {
  const received = sides.direction === 'received';
  const pending = review || a.action_status === 'created' || a.action_status === 'pending';
  type Item = { c: RowCommand; label: string; danger?: boolean };
  const onlyIf = (cond: boolean, ...items: Item[]): Item[] => (cond ? items : []);
  return [
    ...onlyIf(
      review,
      { c: 'accepted', label: t('actions.btn_accept', 'Accept') },
      { c: 'rejected', label: t('actions.btn_reject', 'Reject'), danger: true },
    ),
    ...onlyIf(!received && pending, { c: 'cancelled', label: t('my_actions.withdraw', 'Withdraw'), danger: true }),
    ...onlyIf(received && a.action_status === 'accepted', {
      c: 'completed',
      label: t('my_actions.mark_complete', 'Mark complete'),
    }),
    { c: 'view_profile', label: t('actions.btn_view_profile', 'View profile') },
    ...onlyIf(exportable, { c: 'export', label: t('my_actions.export_profile', 'Export profile') }),
  ];
}

function ActionRow({
  action: a,
  visible,
  colCount,
  selectable,
  selected,
  review,
  exportable,
  labels,
  onToggle,
  onCommand,
}: Readonly<ActionRowProps>) {
  const { t } = useTranslation();
  const sides = sidesOf(a);
  const hasName = !!sides.other.name && sides.other.name !== sides.other.itemId;
  const name = hasName ? sides.other.name! : labels.domainLabel(sides.other.domain);
  const menu = rowMenu(a, sides, review, exportable, t);
  const cells: Record<ColumnId, React.ReactNode> = {
    action: <ActionCell text={actionText(a, sides, t)} type={a.action_type} />,
    direction: <DirectionCell received={sides.direction === 'received'} />,
    status: <StatusCell status={a.action_status} label={labels.statusLabel(a.action_status)} />,
    profile: <div className="truncate px-3 text-[13px]">{labels.profileLabel(sides.mine.itemId)}</div>,
    match: <MatchCell score={a.match_score} />,
    distance: (
      <div className="px-3 text-right tabular-nums">
        {a.distance_m == null ? '—' : `${(a.distance_m / 1000).toFixed(1)} km`}
      </div>
    ),
    updated: (
      <div className="whitespace-nowrap px-3 text-right text-[13px] text-muted-foreground">{when(a.updated_at, t)}</div>
    ),
  };
  const edge = review ? 'shadow-[inset_3px_0_0_theme(colors.amber.500)]' : '';

  return (
    <>
      <tr className={`${review ? '' : 'border-b'} ${edge} ${selected ? 'bg-primary/5' : 'hover:bg-muted/40'}`}>
        <td className="h-[52px]">
          {selectable ? (
            <span className="flex justify-center">
              <SelectBox on={selected} label={t('my_actions.select_row', 'Select {{name}}', { name })} onClick={onToggle} />
            </span>
          ) : null}
        </td>
        <td>
          <div className="flex min-w-0 items-center gap-2.5 px-3">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[13px] font-bold text-primary">
              {name.charAt(0).toUpperCase()}
            </div>
            <div className="flex min-w-0 flex-col">
              {/* One line; the full name on hover when it does not fit. */}
              <span className="truncate font-medium" title={name}>
                {name}
              </span>
              <span className="text-xs text-muted-foreground">{labels.domainLabel(sides.other.domain)}</span>
            </div>
          </div>
        </td>
        {visible.map((id) => (
          <td key={id} className="min-w-0">
            {cells[id]}
          </td>
        ))}
        <td>
          <span className="flex justify-center">
            <RowMenu items={menu} onCommand={onCommand} />
          </span>
        </td>
      </tr>
      {review ? (
        <tr className={`border-b ${edge}`}>
          <td colSpan={colCount} className="pb-3 pl-[54px] pr-3">
            <ReviewStrip action={a} sides={sides} labels={labels} onCommand={onCommand} />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ActionCell({ text, type }: Readonly<{ text: string; type: string }>) {
  return (
    <div className="flex min-w-0 flex-col px-3">
      <span className="truncate">{text}</span>
      <span className="text-xs capitalize text-muted-foreground">{type}</span>
    </div>
  );
}

function DirectionCell({ received }: Readonly<{ received: boolean }>) {
  const { t } = useTranslation();
  const tone = received ? 'text-primary' : 'text-amber-600 dark:text-amber-400';
  const dot = received ? 'bg-primary' : 'bg-amber-600';
  return (
    <div className={`flex items-center gap-1.5 px-3 text-[13px] font-semibold ${tone}`}>
      <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-white ${dot}`}>
        {received ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
      </span>
      {received ? t('my_actions.dir_received', 'Received') : t('my_actions.dir_sent', 'Sent')}
    </div>
  );
}

function StatusCell({ status, label }: Readonly<{ status: string; label: string }>) {
  const style = getStatusStyle(status);
  return (
    <div className="px-3">
      <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${style.cls}`}>
        <span className={`h-1.5 w-1.5 rounded-full ${style.dot}`} />
        {label}
      </span>
    </div>
  );
}

function MatchCell({ score }: Readonly<{ score: number | null | undefined }>) {
  const { t } = useTranslation();
  return (
    <div className="flex justify-end px-3">
      {score == null ? (
        <span className="whitespace-nowrap rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
          {t('my_actions.not_scored', 'Not scored')}
        </span>
      ) : (
        <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
          ★ {Math.round(score * 10)}%
        </span>
      )}
    </div>
  );
}

function RowMenu({
  items,
  onCommand,
}: Readonly<{ items: Array<{ c: RowCommand; label: string; danger?: boolean }>; onCommand: (c: RowCommand) => void }>) {
  const { t } = useTranslation();
  const splitAt = items.findIndex((m) => m.c === 'view_profile');
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('my_actions.more_actions', 'More actions')}>
          <MoreHorizontal className="h-4 w-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        {items.map((m, i) => (
          <React.Fragment key={m.c}>
            {i === splitAt && i > 0 ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem onSelect={() => onCommand(m.c)} className={m.danger ? 'text-red-600 dark:text-red-400' : ''}>
              {m.label}
            </DropdownMenuItem>
          </React.Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ReviewStrip({
  action,
  sides,
  labels,
  onCommand,
}: Readonly<{ action: Action; sides: ActionSides; labels: Labels; onCommand: (c: RowCommand) => void }>) {
  const { t } = useTranslation();
  const summary = Object.entries(action.counterparty?.column_fields ?? {});
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5 dark:border-amber-500/30 dark:bg-amber-500/10">
      <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-bold text-amber-700 dark:text-amber-400">
        <AlertCircle className="h-3.5 w-3.5" />
        {t('my_actions.needs_review', 'Needs your review')}
      </span>
      <div className="flex min-w-[200px] flex-1 flex-wrap gap-x-5 gap-y-1.5">
        {summary.map(([field, value]) => (
          <div key={field} className="flex min-w-0 flex-col">
            <span className="text-[11px] font-semibold text-muted-foreground">
              {labels.fieldLabel(sides.other.domain, field)}
            </span>
            <span className="truncate text-[13px] font-semibold">
              {Array.isArray(value) ? value.join(', ') : String(value)}
            </span>
          </div>
        ))}
      </div>
      <div className="flex shrink-0 gap-1.5">
        <Button variant="outline" size="sm" className="h-8" onClick={() => onCommand('view_profile')}>
          {t('actions.btn_view_profile', 'View profile')}
        </Button>
        <Button variant="outline" size="sm" className="h-8 text-red-600 dark:text-red-400" onClick={() => onCommand('rejected')}>
          {t('actions.btn_reject', 'Reject')}
        </Button>
        <Button size="sm" className="h-8" onClick={() => onCommand('accepted')}>
          {t('actions.btn_accept', 'Accept')}
        </Button>
      </div>
    </div>
  );
}
