import { useTranslation } from 'react-i18next';
import { ArrowUpDown, ChevronDown, SlidersHorizontal, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export type ActionStatusFilter = 'All' | 'Pending' | 'Accepted' | 'Rejected';
export type ActionSort = 'match_score' | 'recent' | 'oldest' | 'distance';

/** One already-humanized active facet chip (field/label/value all display-ready). */
export interface ActiveFacet {
  field: string;
  label: string;
  value: string;
}

export interface ActionToolbarProps {
  status: ActionStatusFilter;
  sort: ActionSort;
  activeFacets: ActiveFacet[];
  onStatusChange: (status: ActionStatusFilter) => void;
  onSortChange: (sort: ActionSort) => void;
  onOpenFilters: () => void;
  onRemoveFacet: (field: string, value: string) => void;
  onClearFilters: () => void;
}

const STATUSES: ActionStatusFilter[] = ['All', 'Pending', 'Accepted', 'Rejected'];

/** All status chip values, exported so callers can validate a URL-sourced chip. */
export const ACTION_STATUS_FILTERS: ActionStatusFilter[] = STATUSES;

/**
 * Maps a status chip to the raw `action_status` values it should match on the
 * server (`action_status` is an OR'd list — see `FetchMyActionsQuery`).
 * `All` → `null` means "don't filter by status at all". Relocated here from
 * `action-list.tsx` (#439 Task 9) so both the page (which builds the hook's
 * query params from the chip) and any other status-chip consumer share one
 * definition instead of duplicating it.
 */
export const FILTER_STATUSES: Record<ActionStatusFilter, string[] | null> = {
  All: null,
  Pending: ['created', 'pending'],
  Accepted: ['accepted', 'completed'],
  Rejected: ['rejected', 'cancelled'],
};

const SORT_OPTIONS: Array<{ value: ActionSort; key: string }> = [
  { value: 'match_score', key: 'actions.sort_match_score' },
  { value: 'recent', key: 'actions.sort_recent' },
  { value: 'oldest', key: 'actions.sort_oldest' },
  { value: 'distance', key: 'actions.sort_distance' },
];

const STATUS_LABEL_KEYS: Record<ActionStatusFilter, string> = {
  All: 'actions.filter_all',
  Pending: 'actions.filter_pending',
  Accepted: 'actions.filter_accepted',
  Rejected: 'actions.filter_rejected',
};

/**
 * Presentational toolbar for the My Actions page: status chips, a sort
 * dropdown, a Filters button (with active-count badge), and — once facets are
 * active — a row of removable tokens plus "Clear all". Owns no state: every
 * value comes in via props, every change goes out via a callback. The page
 * (Task 13) wires this to the URL-backed filter/sort state.
 */
export function ActionToolbar({
  status,
  sort,
  activeFacets,
  onStatusChange,
  onSortChange,
  onOpenFilters,
  onRemoveFacet,
  onClearFilters,
}: ActionToolbarProps) {
  const { t } = useTranslation();
  const activeSortOption = SORT_OPTIONS.find((option) => option.value === sort) ?? SORT_OPTIONS[0];
  const hasFacets = activeFacets.length > 0;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 sm:gap-3">
        {/* Status chip group */}
        <div className="inline-flex flex-wrap gap-1 rounded-xl border bg-card p-1">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              data-testid={`status-chip-${s}`}
              aria-pressed={s === status}
              onClick={() => onStatusChange(s)}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-medium transition pointer-coarse:min-h-11 sm:px-3 ${
                s === status
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t(STATUS_LABEL_KEYS[s])}
            </button>
          ))}
        </div>

        {/* Sort dropdown */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" data-testid="sort-trigger">
              <ArrowUpDown className="h-3.5 w-3.5" />
              {t(activeSortOption.key)}
              <ChevronDown className="h-3.5 w-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {SORT_OPTIONS.map((option) => (
              <DropdownMenuItem
                key={option.value}
                data-testid={`sort-option-${option.value}`}
                onSelect={() => onSortChange(option.value)}
                className={option.value === sort ? 'bg-primary/10 text-primary font-semibold' : undefined}
              >
                {t(option.key)}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        {/* Filters button */}
        <Button variant="outline" size="sm" data-testid="filters-button" onClick={onOpenFilters}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
          {t('filters.title', 'Filters')}
          {hasFacets && (
            <span
              data-testid="filters-count"
              className="inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-primary px-1.5 text-[11px] font-bold text-primary-foreground"
            >
              {activeFacets.length}
            </span>
          )}
        </Button>
      </div>

      {/* Active-facet tokens */}
      {hasFacets && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {activeFacets.map((facet) => (
            <span
              key={`${facet.field}:${facet.value}`}
              className="inline-flex items-center gap-1 rounded-lg bg-primary/10 px-2.5 py-1 font-medium text-primary"
            >
              {facet.label}: {facet.value}
              <button
                type="button"
                data-testid={`facet-remove-${facet.field}-${facet.value}`}
                aria-label={t('actions.remove_filter', 'Remove filter')}
                onClick={() => onRemoveFacet(facet.field, facet.value)}
                className="ml-0.5 rounded-full p-0.5 hover:bg-primary/20"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
          <button
            type="button"
            data-testid="clear-filters"
            onClick={onClearFilters}
            className="font-semibold text-primary hover:underline"
          >
            {t('filters.clear_all', 'Clear all')}
          </button>
        </div>
      )}
    </div>
  );
}
