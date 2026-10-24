import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  RefreshCw,
  Inbox,
  Send,
  AlertCircle,
  CheckSquare,
  Loader2,
  Download,
  X,
} from 'lucide-react';
import { ActionCard } from './action-card';
import { ActionToolbar, type ActionStatusFilter, type ActionSort, type ActiveFacet } from './action-toolbar';
import { SelectableCard } from '@/components/selection/selectable-card';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import type { CardSelection } from '@/hooks/use-card-selection';
import type { Action } from '@/lib/action-api';

interface ActionListProps {
  initiatedActions: Action[];
  receivedActions: Action[];
  // Tab badge counts: the server-side total per tab, not the loaded rows.
  // Falls back to the loaded length when undefined.
  initiatedTotal?: number;
  receivedTotal?: number;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  activeTab: 'initiated' | 'received';
  onTabChange: (tab: 'initiated' | 'received') => void;
  onStatusUpdate: (action: Action, targetStatus: string) => void;
  onRefresh: () => void;
  isRefetching: boolean;
  /** Selection state owned by the page. */
  selection: CardSelection;
  /** Open the bulk confirm dialog for the given target status. */
  onBulkAction: (targetStatus: string) => void;
  /**
   * Bulk export is enabled for the viewer's domain: cards in an exportable
   * status become selectable on both tabs, and `exportControls` are shown.
   */
  exportEnabled?: boolean;
  /**
   * Action statuses the viewer may export — the network's reveal statuses for
   * the interactions their domain can export (e.g. accepted, completed).
   */
  exportStatuses?: readonly string[];
  /** Every selected card can be bulk-completed (Received + accepted). */
  canComplete?: boolean;
  /** Download control, rendered in the bulk bar when `exportEnabled`. */
  exportControls?: React.ReactNode;
  /**
   * Select every loaded exportable card on both tabs. When given (and export
   * is enabled) the bulk bar offers "Select all loaded".
   */
  onSelectAllLoaded?: () => void;
  /** How the (cross-tab) selection splits between the Sent and Received tabs. */
  selectionSplit?: { sent: number; received: number };
  // Toolbar: state and URL wiring live on the page; forwarded to `ActionToolbar`.
  toolbarStatus: ActionStatusFilter;
  toolbarSort: ActionSort;
  activeFacets: ActiveFacet[];
  onStatusChange: (status: ActionStatusFilter) => void;
  onSortChange: (sort: ActionSort) => void;
  onOpenFilters: () => void;
  onRemoveFacet: (field: string, value: string) => void;
  onClearFilters: () => void;
  // Infinite scroll. The server filters, so every row given is rendered.
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

// A card's actionable class for the tab, used as the selection lock group
// (null means not selectable). The first pick locks the class, so a batch is
// homogeneous: Received bulk accept/reject (pending) or complete (accepted),
// Initiated bulk cancel (pending).
type ActionClass = 'pending' | 'accepted';

// With bulk export enabled, a card in any exportable status is selectable on
// both tabs, in the 'accepted' group, so it can be downloaded.
function actionClassFor(
  tab: 'initiated' | 'received',
  status: string,
  exportStatuses: readonly string[] = [],
): ActionClass | null {
  if (status === 'created' || status === 'pending') return 'pending';
  if (tab === 'received' && status === 'accepted') return 'accepted';
  if (exportStatuses.includes(status)) return 'accepted';
  return null;
}

export function ActionList({
  initiatedActions,
  receivedActions,
  initiatedTotal,
  receivedTotal,
  isLoading,
  isError,
  error,
  activeTab,
  onTabChange,
  onStatusUpdate,
  onRefresh,
  isRefetching,
  selection,
  onBulkAction,
  exportEnabled = false,
  exportStatuses = [],
  canComplete,
  exportControls,
  onSelectAllLoaded,
  selectionSplit,
  toolbarStatus,
  toolbarSort,
  activeFacets,
  onStatusChange,
  onSortChange,
  onOpenFilters,
  onRemoveFacet,
  onClearFilters,
  hasNextPage,
  isFetchingNextPage,
  onLoadMore,
}: Readonly<ActionListProps>) {
  const { t } = useTranslation();

  const actions = activeTab === 'initiated' ? initiatedActions : receivedActions;

  const isSelectable = (a: Action) =>
    actionClassFor(activeTab, a.action_status, exportEnabled ? exportStatuses : []) !== null;
  const hasSelectable = actions.some(isSelectable);

  const tabs = [
    {
      id: 'initiated' as const,
      label: t('actions.tab_initiated'),
      Icon: Send,
      count: initiatedTotal ?? initiatedActions.length,
    },
    {
      id: 'received' as const,
      label: t('actions.tab_received'),
      Icon: Inbox,
      count: receivedTotal ?? receivedActions.length,
    },
  ];
  const activeIdx = tabs.findIndex((tab) => tab.id === activeTab);

  // Extracted to avoid a nested ternary (typescript:S3358).
  const emptyOrListContent =
    actions.length === 0 ? (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed py-14 text-center">
        <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/10 text-primary">
          {activeTab === 'initiated' ? <Send className="h-6 w-6" /> : <Inbox className="h-6 w-6" />}
        </div>
        <h3 className="text-base font-bold text-foreground">
          {activeTab === 'initiated' ? t('actions.empty_initiated_heading') : t('actions.empty_received_heading')}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {activeTab === 'initiated'
            ? t('actions.empty_initiated_desc')
            : t('actions.empty_received_desc')}
        </p>
      </div>
    ) : (
      <>
        <div data-tour="action-list" className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {actions.map((action) => {
            const cls = actionClassFor(
              activeTab,
              action.action_status,
              exportEnabled ? exportStatuses : [],
            );
            return (
              <SelectableCard
                key={action.action_id}
                id={action.action_id}
                selectMode={selection.selectMode}
                selected={selection.isSelected(action.action_id)}
                selectable={cls !== null && selection.canSelect(cls)}
                onToggle={(id) => selection.toggle(id, cls ?? '')}
              >
                <ActionCard
                  action={action}
                  ownershipRole={activeTab}
                  onStatusUpdate={onStatusUpdate}
                  selectionMode={selection.selectMode}
                />
              </SelectableCard>
            );
          })}
        </div>
        {hasNextPage && (
          <div className="flex justify-center pt-2">
            <Button
              variant="outline"
              data-testid="load-more-button"
              onClick={onLoadMore}
              disabled={isFetchingNextPage}
            >
              {isFetchingNextPage && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {isFetchingNextPage ? t('actions.loading_more') : t('actions.load_more')}
            </Button>
          </div>
        )}
      </>
    );
  const nonLoadingContent = isError ? (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed py-14 text-center">
      <AlertCircle className="mb-3 h-10 w-10 text-destructive" />
      <h3 className="text-lg font-semibold text-destructive">{t('actions.error_heading')}</h3>
      <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
        {error?.message ?? t('actions.error_fallback')}
      </p>
    </div>
  ) : (
    emptyOrListContent
  );

  return (
    <div className="w-full space-y-5">
      {/* Toolbar: status, sort, filters, select, refresh */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ActionToolbar
          status={toolbarStatus}
          sort={toolbarSort}
          activeFacets={activeFacets}
          onStatusChange={(status) => {
            onStatusChange(status);
            // A status change can hide selected cards, so leave select mode.
            selection.exitSelect();
          }}
          onSortChange={onSortChange}
          onOpenFilters={onOpenFilters}
          onRemoveFacet={onRemoveFacet}
          onClearFilters={onClearFilters}
        />

        <div className="flex items-center gap-2">
          {/* Export starts selection; every selection action lives in the
              bulk bar. */}
          {selection.selectMode ? (
            <Button variant="outline" size="sm" onClick={() => selection.exitSelect()}>
              <X className="mr-2 h-4 w-4" />
              {t('selection.cancel')}
            </Button>
          ) : (
            <>
              {exportEnabled && (
                <Button variant="outline" size="sm" onClick={() => selection.enterSelect()}>
                  <Download className="mr-2 h-4 w-4" />
                  {t('actions.export_entry')}
                </Button>
              )}
              {hasSelectable && (
                <Button variant="outline" size="sm" onClick={() => selection.enterSelect()}>
                  <CheckSquare className="mr-2 h-4 w-4" />
                  {t('selection.select')}
                </Button>
              )}
            </>
          )}

          <Button data-tour="action-refresh" variant="outline" size="sm" onClick={onRefresh} disabled={isRefetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
            {t('actions.refresh')}
          </Button>
        </div>
      </div>

      {/* Sliding-pill tabs */}
      <div data-tour="action-tabs" className="relative flex rounded-2xl border bg-muted/60 p-1.5">
        <div
          className="absolute bottom-1.5 top-1.5 rounded-xl bg-card shadow-sm transition-[left] duration-300"
          style={{ left: `calc(${activeIdx * 50}% + 6px)`, width: 'calc(50% - 12px)' }}
        />
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onTabChange(tab.id)}
              className={`relative z-10 flex flex-1 items-center justify-center gap-2 py-2.5 text-sm transition-colors ${
                isActive ? 'font-bold text-primary' : 'font-semibold text-muted-foreground'
              }`}
            >
              <tab.Icon className={`h-4 w-4 ${isActive ? 'text-primary' : 'text-muted-foreground'}`} />
              {tab.label}
              <span
                className={`inline-flex h-5 min-w-[22px] items-center justify-center rounded-full px-1.5 text-[11px] font-bold ${
                  isActive ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'
                }`}
              >
                {tab.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Content */}
      {isLoading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <ActionCardSkeleton key={i} />
          ))}
        </div>
      ) : (
        nonLoadingContent
      )}
      {selection.selectMode && selection.selected.size > 0 && (
        <BulkActionBar
          count={selection.selected.size}
          onClear={selection.clear}
          detail={
            selectionSplit && selection.lockKey === 'accepted'
              ? t('actions.selection_split', selectionSplit)
              : undefined
          }
          secondary={
            exportEnabled && onSelectAllLoaded && selection.lockKey === 'accepted' ? (
              <button
                type="button"
                onClick={onSelectAllLoaded}
                className="rounded-lg border border-background/30 px-3 py-1.5 text-xs font-semibold text-background/80 transition hover:text-background"
              >
                {t('selection.select_all_loaded')}
              </button>
            ) : undefined
          }
        >
          {exportEnabled && selection.lockKey === 'accepted' && exportControls}
          {selection.lockKey === 'accepted' ? (
            // Bulk complete only when every selected card is Received +
            // accepted, so it never acts on part of the selection. Without
            // `canComplete`, falls back to "nothing from Sent is selected".
            (canComplete ?? (selectionSplit?.sent ?? 0) === 0) && (
              <button
                type="button"
                onClick={() => onBulkAction('completed')}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white"
              >
                {t('actions.bulk_complete')}
              </button>
            )
          ) : activeTab === 'received' ? (
            // Received + pending: bulk accept / reject.
            <>
              <button
                type="button"
                onClick={() => onBulkAction('rejected')}
                className="rounded-lg bg-background px-4 py-1.5 text-xs font-bold text-red-600"
              >
                {t('actions.bulk_reject')}
              </button>
              <button
                type="button"
                onClick={() => onBulkAction('accepted')}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white"
              >
                {t('actions.bulk_accept')}
              </button>
            </>
          ) : (
            // Initiated + pending: bulk cancel.
            <button
              type="button"
              onClick={() => onBulkAction('cancelled')}
              className="rounded-lg bg-background px-4 py-1.5 text-xs font-bold text-red-600"
            >
              {t('actions.bulk_cancel')}
            </button>
          )}
        </BulkActionBar>
      )}
    </div>
  );
}

function ActionCardSkeleton() {
  return (
    <div className="space-y-4 rounded-[18px] border p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="flex gap-2">
          <Skeleton className="h-6 w-20 rounded-full" />
          <Skeleton className="h-6 w-16 rounded-full" />
        </div>
        <Skeleton className="h-4 w-20" />
      </div>
      <div className="flex items-center gap-3">
        <Skeleton className="h-11 w-11 rounded-full" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
        </div>
      </div>
      <Skeleton className="h-20 w-full rounded-xl" />
      <div className="flex gap-2">
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 flex-1" />
      </div>
    </div>
  );
}
