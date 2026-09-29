import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { format, isToday, isYesterday } from 'date-fns';
import { AlertCircle, ArrowDownLeft, ArrowUpRight, ChevronLeft, ChevronRight, MoreHorizontal, X } from 'lucide-react';
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
import type { Action } from '@/lib/action-api';
import { needsResponse, pageList, PAGE_SIZES, sidesOf } from '@/lib/my-actions-view';
import type { ColumnId } from './my-actions-toolbar';

export type RowCommand = 'accepted' | 'rejected' | 'cancelled' | 'completed' | 'view_profile' | 'export';

export interface BulkCommand {
  id: string;
  label: string;
  count: number;
  tone: 'accept' | 'reject' | 'primary' | 'neutral';
  onClick: () => void;
}

interface ActionsTableProps {
  rows: Action[];
  total: number;
  page: number;
  per: number;
  onPage: (page: number) => void;
  onPer: (per: number) => void;
  columns: Record<ColumnId, boolean>;
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  pendingStatuses: readonly string[];
  exportStatuses: readonly string[];
  canExport: boolean;
  /** Label of the counterparty's domain, e.g. "Seeker". */
  domainLabel: (domain: string) => string;
  /** Label of one of the caller's own profiles, by item id. */
  profileLabel: (itemId: string) => string;
  /** Title of a counterparty schema field, e.g. "Education". */
  fieldLabel: (domain: string, field: string) => string;
  statusLabel: (status: string) => string;
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onTogglePage: (ids: string[], on: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  bulkCommands: BulkCommand[];
  onCommand: (action: Action, command: RowCommand) => void;
}

function when(iso: string, t: (k: string, d: string) => string): string {
  const d = new Date(iso);
  const clock = format(d, 'h:mm a');
  if (isToday(d)) return `${t('my_actions.today', 'Today')}, ${clock}`;
  if (isYesterday(d)) return `${t('my_actions.yesterday', 'Yesterday')}, ${clock}`;
  return format(d, 'd MMM, h:mm a');
}

const toneClass: Record<BulkCommand['tone'], string> = {
  accept: 'bg-emerald-600 text-white hover:bg-emerald-600/90 border-emerald-600',
  reject: 'bg-white text-red-600 hover:bg-white/90 border-white',
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 border-primary',
  neutral: 'bg-transparent text-white border-white/30 hover:bg-white/10',
};

/**
 * The My Actions table: one row per sent or received action, a "needs your
 * review" strip under received pending rows (the counterparty's summary
 * fields plus Accept / Reject), a per-row menu, a bulk bar above and
 * pagination below. Purely presentational — every change is a callback.
 */
export function ActionsTable(props: Readonly<ActionsTableProps>) {
  const { t } = useTranslation();
  const {
    rows,
    total,
    page,
    per,
    columns,
    selected,
    pendingStatuses,
    exportStatuses,
    canExport,
    bulkCommands,
  } = props;

  const pages = Math.max(1, Math.ceil(total / per));
  const pageIds = rows.map((r) => r.action_id);
  const pageSelected = pageIds.filter((id) => selected.has(id)).length;
  const allOnPage = pageIds.length > 0 && pageSelected === pageIds.length;
  const someOnPage = pageSelected > 0 && !allOnPage;

  const cols: Array<{ id: ColumnId; label: string; width: string; right?: boolean }> = [
    { id: 'action', label: t('my_actions.col_action', 'Action'), width: 'minmax(150px,1.1fr)' },
    { id: 'direction', label: t('my_actions.col_direction', 'Direction'), width: '120px' },
    { id: 'status', label: t('my_actions.col_status', 'Status'), width: '120px' },
    { id: 'profile', label: t('my_actions.col_profile', 'Profile'), width: '130px' },
    { id: 'match', label: t('my_actions.col_match', 'Match'), width: '110px', right: true },
    { id: 'distance', label: t('my_actions.col_distance', 'Distance'), width: '96px', right: true },
    { id: 'updated', label: t('my_actions.col_updated', 'Updated'), width: '150px', right: true },
  ];
  const visible = cols.filter((c) => columns[c.id]);
  const grid = `44px minmax(200px,1.3fr) ${visible.map((c) => c.width).join(' ')} 56px`;
  const minWidth = 44 + 200 + 56 + visible.reduce((n, c) => n + (c.width.endsWith('px') ? parseInt(c.width, 10) : 150), 0);

  const cb = (on: boolean, partial = false) =>
    `flex h-[18px] w-[18px] items-center justify-center rounded-[5px] border-[1.5px] ${
      on || partial ? 'border-primary bg-primary text-primary-foreground' : 'border-input bg-background'
    }`;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border bg-card">
      {selected.size > 0 ? (
        <div className="flex flex-wrap items-center gap-2 bg-slate-900 px-4 py-2.5 text-white" role="region" aria-label={t('my_actions.selection', 'Selection')}>
          <span className="text-sm font-bold">
            {t('my_actions.n_selected', '{{count}} selected', { count: selected.size })}
          </span>
          <span className="text-xs text-slate-400">{t('my_actions.of_total', 'of {{total}}', { total })}</span>
          {selected.size < total ? (
            <button type="button" className="text-xs font-semibold text-sky-300 underline" onClick={props.onSelectAll}>
              {t('my_actions.select_all_n', 'Select all {{total}}', { total })}
            </button>
          ) : null}
          <span className="flex-1" />
          {bulkCommands.map((b) => (
            <Button
              key={b.id}
              size="sm"
              variant="outline"
              disabled={b.count === 0}
              className={`h-8 ${toneClass[b.tone]} disabled:opacity-40`}
              onClick={b.onClick}
            >
              {b.label} ({b.count})
            </Button>
          ))}
          <button
            type="button"
            onClick={props.onClearSelection}
            aria-label={t('my_actions.clear_selection', 'Clear selection')}
            className="flex h-8 w-8 items-center justify-center rounded hover:bg-white/10"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : null}

      <div className="overflow-x-auto">
        <div style={{ minWidth }} role="table" aria-rowcount={total}>
          <div
            role="row"
            className="grid h-10 items-center border-b bg-muted/40 text-xs font-semibold text-muted-foreground"
            style={{ gridTemplateColumns: grid }}
          >
            <div className="flex justify-center" role="columnheader">
              <button
                type="button"
                aria-label={t('my_actions.select_page', 'Select page')}
                className={cb(allOnPage, someOnPage)}
                onClick={() => props.onTogglePage(pageIds, !allOnPage)}
              >
                {allOnPage ? '✓' : someOnPage ? <span className="h-0.5 w-2 bg-white" /> : null}
              </button>
            </div>
            <div className="px-3" role="columnheader">{t('my_actions.col_name', 'Name')}</div>
            {visible.map((c) => (
              <div key={c.id} role="columnheader" className={`px-3 ${c.right ? 'text-right' : ''}`}>
                {c.label}
              </div>
            ))}
            <div role="columnheader" />
          </div>

          {props.isLoading ? (
            Array.from({ length: Math.min(per, 5) }).map((_, i) => (
              <div key={i} className="border-b px-4 py-3">
                <Skeleton className="h-6 w-full" />
              </div>
            ))
          ) : props.isError ? (
            <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
              <p className="font-semibold">{t('my_actions.load_failed', "Actions couldn't be loaded")}</p>
              <Button variant="outline" size="sm" onClick={props.onRetry}>
                {t('my_actions.retry', 'Try again')}
              </Button>
            </div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1 px-6 py-14 text-center">
              <p className="font-semibold">{t('my_actions.empty_title', 'No actions match')}</p>
              <p className="text-sm text-muted-foreground">
                {t('my_actions.empty_body', 'Try removing a filter or clearing the search.')}
              </p>
            </div>
          ) : (
            rows.map((a) => (
              <Row
                key={a.action_id}
                action={a}
                grid={grid}
                visible={visible.map((c) => c.id)}
                selected={selected.has(a.action_id)}
                checkboxClass={cb}
                review={needsResponse(a, pendingStatuses)}
                exportable={canExport && exportStatuses.includes(a.action_status)}
                labels={{ ...props, when: (iso: string) => when(iso, t) }}
                onToggle={() => props.onToggle(a.action_id)}
                onCommand={(c) => props.onCommand(a, c)}
              />
            ))
          )}
        </div>
      </div>

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
        <span>
          {total > 0
            ? t('my_actions.range', 'Showing {{from}}–{{to}} of {{total}}', {
                from: (page - 1) * per + 1,
                to: Math.min(page * per, total),
                total,
              })
            : t('my_actions.no_results', '0 results')}
        </span>
        <nav className="flex items-center gap-1" aria-label={t('my_actions.pagination', 'Pagination')}>
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={page <= 1} onClick={() => props.onPage(page - 1)} aria-label={t('my_actions.prev_page', 'Previous page')}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          {pageList(page, pages).map((p, i) =>
            p === '…' ? (
              <span key={`gap-${i}`} className="px-1">…</span>
            ) : (
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
            ),
          )}
          <Button variant="outline" size="icon" className="h-8 w-8" disabled={page >= pages} onClick={() => props.onPage(page + 1)} aria-label={t('my_actions.next_page', 'Next page')}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </nav>
      </div>
    </div>
  );
}

interface RowProps {
  action: Action;
  grid: string;
  visible: ColumnId[];
  selected: boolean;
  checkboxClass: (on: boolean) => string;
  review: boolean;
  exportable: boolean;
  labels: Pick<ActionsTableProps, 'domainLabel' | 'profileLabel' | 'fieldLabel' | 'statusLabel'> & {
    when: (iso: string) => string;
  };
  onToggle: () => void;
  onCommand: (c: RowCommand) => void;
}

function Row({ action: a, grid, visible, selected, checkboxClass, review, exportable, labels, onToggle, onCommand }: Readonly<RowProps>) {
  const { t } = useTranslation();
  const sides = sidesOf(a);
  const received = sides.direction === 'received';
  const hasName = !!sides.other.name && sides.other.name !== sides.other.itemId;
  const name = hasName ? sides.other.name! : labels.domainLabel(sides.other.domain);
  const status = getStatusStyle(a.action_status);
  const isApply = a.action_type === 'apply';
  const actionText = received
    ? isApply
      ? t('my_actions.row_applied', 'Applied to your listing')
      : t('my_actions.row_wants_connect', 'Wants to connect')
    : isApply
      ? t('my_actions.row_you_applied', 'You applied')
      : t('my_actions.row_you_invited', 'You invited to connect');
  const summary = Object.entries(a.counterparty?.summary ?? {});
  const pending = a.action_status === 'created' || a.action_status === 'pending' || review;

  const menu: Array<{ c: RowCommand; label: string; danger?: boolean }> = [
    ...(review
      ? [
          { c: 'accepted' as const, label: t('actions.btn_accept', 'Accept') },
          { c: 'rejected' as const, label: t('actions.btn_reject', 'Reject'), danger: true },
        ]
      : []),
    ...(!received && pending ? [{ c: 'cancelled' as const, label: t('my_actions.withdraw', 'Withdraw'), danger: true }] : []),
    ...(received && a.action_status === 'accepted'
      ? [{ c: 'completed' as const, label: t('my_actions.mark_complete', 'Mark complete') }]
      : []),
    { c: 'view_profile', label: t('actions.btn_view_profile', 'View profile') },
    ...(exportable ? [{ c: 'export' as const, label: t('my_actions.export_profile', 'Export profile') }] : []),
  ];

  const cell = (id: ColumnId) => {
    switch (id) {
      case 'action':
        return (
          <div className="flex min-w-0 flex-col px-3">
            <span className="truncate">{actionText}</span>
            <span className="text-xs capitalize text-muted-foreground">{a.action_type}</span>
          </div>
        );
      case 'direction':
        return (
          <div className={`flex items-center gap-1.5 px-3 text-[13px] font-semibold ${received ? 'text-primary' : 'text-amber-600'}`}>
            <span className={`flex h-[18px] w-[18px] items-center justify-center rounded-full text-white ${received ? 'bg-primary' : 'bg-amber-600'}`}>
              {received ? <ArrowDownLeft className="h-3 w-3" /> : <ArrowUpRight className="h-3 w-3" />}
            </span>
            {received ? t('my_actions.dir_received', 'Received') : t('my_actions.dir_sent', 'Sent')}
          </div>
        );
      case 'status':
        return (
          <div className="px-3">
            <span className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${status.cls}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {labels.statusLabel(a.action_status)}
            </span>
          </div>
        );
      case 'profile':
        return <div className="truncate px-3 text-[13px]">{labels.profileLabel(sides.mine.itemId)}</div>;
      case 'match':
        return (
          <div className="flex justify-end px-3">
            {a.match_score != null ? (
              <span className="rounded-full bg-primary px-2.5 py-0.5 text-xs font-semibold text-primary-foreground">
                ★ {Math.round(a.match_score * 10)}%
              </span>
            ) : (
              <span className="whitespace-nowrap rounded-full bg-muted px-2.5 py-0.5 text-xs text-muted-foreground">
                {t('my_actions.not_scored', 'Not scored')}
              </span>
            )}
          </div>
        );
      case 'distance':
        return (
          <div className="px-3 text-right tabular-nums">
            {a.distance_m != null ? `${(a.distance_m / 1000).toFixed(1)} km` : '—'}
          </div>
        );
      case 'updated':
        return <div className="whitespace-nowrap px-3 text-right text-[13px] text-muted-foreground">{labels.when(a.updated_at)}</div>;
    }
  };

  return (
    <div role="rowgroup" className={`border-b ${review ? 'shadow-[inset_3px_0_0_theme(colors.amber.500)]' : ''}`}>
      <div
        role="row"
        className={`grid min-h-[52px] items-center text-sm ${selected ? 'bg-primary/5' : 'hover:bg-muted/40'}`}
        style={{ gridTemplateColumns: grid }}
      >
        <div className="flex justify-center" role="cell">
          <button
            type="button"
            aria-label={t('my_actions.select_row', 'Select {{name}}', { name })}
            aria-pressed={selected}
            className={checkboxClass(selected)}
            onClick={onToggle}
          >
            {selected ? '✓' : null}
          </button>
        </div>
        <div className="flex min-w-0 items-center gap-2.5 px-3" role="cell">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[13px] font-bold text-primary">
            {name.charAt(0).toUpperCase()}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-medium">{name}</span>
            <span className="text-xs text-muted-foreground">{labels.domainLabel(sides.other.domain)}</span>
          </div>
        </div>
        {visible.map((id) => (
          <div key={id} role="cell" className="min-w-0">
            {cell(id)}
          </div>
        ))}
        <div className="flex justify-center" role="cell">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8" aria-label={t('my_actions.more_actions', 'More actions')}>
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {menu.map((m, i) => (
                <React.Fragment key={m.c}>
                  {m.c === 'view_profile' && i > 0 ? <DropdownMenuSeparator /> : null}
                  <DropdownMenuItem onSelect={() => onCommand(m.c)} className={m.danger ? 'text-red-600' : ''}>
                    {m.label}
                  </DropdownMenuItem>
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {review ? (
        <div className="sticky left-[54px] mx-3 mb-3 ml-[54px] flex max-w-[calc(100%-66px)] flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-amber-200 bg-amber-50/60 px-3 py-2.5">
          <span className="flex items-center gap-1.5 whitespace-nowrap text-xs font-bold text-amber-700">
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
            <Button variant="outline" size="sm" className="h-8 text-red-600" onClick={() => onCommand('rejected')}>
              {t('actions.btn_reject', 'Reject')}
            </Button>
            <Button size="sm" className="h-8" onClick={() => onCommand('accepted')}>
              {t('actions.btn_accept', 'Accept')}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
