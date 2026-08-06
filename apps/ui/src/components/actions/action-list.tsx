import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { RefreshCw, Inbox, Send, AlertCircle, CheckSquare, Loader2 } from 'lucide-react';
import { ActionCard } from './action-card';
import { ActionToolbar, type ActionStatusFilter, type ActionSort, type ActiveFacet } from './action-toolbar';
import { SelectableCard } from '@/components/selection/selectable-card';
import { BulkActionBar } from '@/components/selection/bulk-action-bar';
import type { CardSelection } from '@/hooks/use-card-selection';
import type { Action } from '@/lib/action-api';

interface ActionListProps {
  initiatedActions: Action[];
  receivedActions: Action[];
  // Tab badge counts (#439 follow-up): the true server-side total for each
  // tab, independent of how many rows the infinite query has loaded so far.
  // Falls back to the loaded array length when undefined (e.g. tests that
  // don't pass it, or a query that hasn't resolved a first page yet).
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
  /** Selection state owned by the page (drives bulk accept/reject/cancel). */
  selection: CardSelection;
  /** Open the bulk confirm dialog for the given target status. */
  onBulkAction: (targetStatus: string) => void;
  // ── Toolbar (#439 Task 13) — all state/URL-wiring lives on the page; this
  // component only renders `ActionToolbar` and forwards its callbacks. ──────
  toolbarStatus: ActionStatusFilter;
  toolbarSort: ActionSort;
  activeFacets: ActiveFacet[];
  onStatusChange: (status: ActionStatusFilter) => void;
  onSortChange: (sort: ActionSort) => void;
  onOpenFilters: () => void;
  onRemoveFacet: (field: string, value: string) => void;
  onClearFilters: () => void;
  // ── Infinite scroll (#439 Task 13) — the server now does the filtering, so
  // this component renders every row it's given (no client-side re-filter). ─
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  onLoadMore: () => void;
}

// The actionable "class" of a card for the current tab — used as the selection
// lock group. null = not actionable (can't be selected). The first card picked
// locks the class, so a batch is always homogeneous: on the Received tab you
// bulk accept/reject a set of PENDING items OR bulk complete a set of ACCEPTED
// items (never mixed); on the Initiated tab you bulk cancel PENDING items.
type ActionClass = 'pending' | 'accepted';

function actionClassFor(tab: 'initiated' | 'received', status: string): ActionClass | null {
  if (status === 'created' || status === 'pending') return 'pending';
  if (tab === 'received' && status === 'accepted') return 'accepted';
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
}: ActionListProps) {
  const { t } = useTranslation();

  // The server already applied status/sort/facets (#439) — render every row
  // handed down, no client-side re-filter.
  const actions = activeTab === 'initiated' ? initiatedActions : receivedActions;

  // A card is selectable when it has an actionable class for this tab. The
  // lock group is that class, so the first pick fixes pending-vs-accepted.
  const isSelectable = (a: Action) => actionClassFor(activeTab, a.action_status) !== null;
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

  return (
    <div className="w-full space-y-5">
      {/* Toolbar: status/sort/filters (server-driven, #439) + select/refresh */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <ActionToolbar
          status={toolbarStatus}
          sort={toolbarSort}
          activeFacets={activeFacets}
          onStatusChange={(status) => {
            onStatusChange(status);
            // Changing the status can hide selected cards; drop out of
            // select mode so the selection never goes invisible/stale.
            selection.exitSelect();
          }}
          onSortChange={onSortChange}
          onOpenFilters={onOpenFilters}
          onRemoveFacet={onRemoveFacet}
          onClearFilters={onClearFilters}
        />

        <div className="flex items-center gap-2">
          {(hasSelectable || selection.selectMode) && (
            <Button
              variant={selection.selectMode ? 'default' : 'outline'}
              size="sm"
              onClick={() => (selection.selectMode ? selection.exitSelect() : selection.enterSelect())}
            >
              <CheckSquare className="mr-2 h-4 w-4" />
              {selection.selectMode ? t('selection.done') : t('selection.select')}
            </Button>
          )}

          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isRefetching}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefetching ? 'animate-spin' : ''}`} />
            {t('actions.refresh')}
          </Button>
        </div>
      </div>

      {/* Sliding-pill tabs */}
      <div className="relative flex rounded-2xl border bg-muted/60 p-1.5">
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
      ) : isError ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed py-14 text-center">
          <AlertCircle className="mb-3 h-10 w-10 text-destructive" />
          <h3 className="text-lg font-semibold text-destructive">{t('actions.error_heading')}</h3>
          <p className="mt-1.5 max-w-md text-sm text-muted-foreground">
            {error?.message ?? t('actions.error_fallback')}
          </p>
        </div>
      ) : actions.length === 0 ? (
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
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
            {actions.map((action) => {
              const cls = actionClassFor(activeTab, action.action_status);
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
      )}
      {selection.selectMode && selection.selected.size > 0 && (
        <BulkActionBar count={selection.selected.size} onClear={selection.clear}>
          {selection.lockKey === 'accepted' ? (
            // Received + accepted selection → bulk complete.
            <button
              type="button"
              onClick={() => onBulkAction('completed')}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-xs font-bold text-white"
            >
              {t('actions.bulk_complete')}
            </button>
          ) : activeTab === 'received' ? (
            // Received + pending selection → bulk accept / reject.
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
            // Initiated + pending selection → bulk cancel.
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
