import { useTranslation } from 'react-i18next';
import { DomainControl } from './domain-control';
import { AppliedFilterChips } from './applied-filter-chips';
import { SortSelect } from './sort-select';
import { AreaSelect } from './area-select';
import type { DomainOption } from './domain-control';
import type { AppliedChip } from './applied-filter-chips';
import type { BrowseArea, BrowseSort } from '@/lib/browse-discover';
import type { ViewMode } from '@/engine/types';

export interface BrowseToolbarProps {
  viewMode: ViewMode;
  domainOptions: DomainOption[];
  selectedDomains: string[];
  onDomainsChange: (next: string[]) => void;
  /** Server-reported total for the active feed; omitted while loading. */
  count?: number;
  sort: BrowseSort;
  /** `meta.sort_applied` — what the server actually did. */
  sortApplied?: BrowseSort;
  nearestAvailable: boolean;
  relevanceBasis: 'profile' | 'search' | null;
  onSortChange: (next: BrowseSort) => void;
  area: BrowseArea;
  /** Centre offered when the user picks a radius; null when none resolves. */
  defaultCenter: { lat: number; lng: number } | null;
  onAreaChange: (next: BrowseArea) => void;
  chips: AppliedChip[];
  onRemoveChip: (chip: AppliedChip) => void;
  onClearAll: () => void;
}

/**
 * The browse state bar (#644/#645, spec §7.2).
 *
 * Division of labour (spec §7.1): the APP BAR owns the EDITORS — the search
 * box and the facet-panel trigger, neither of which moves here. This bar owns
 * the STATE read-out, plus the two controls that had no previous home, `sort`
 * and `area`. Nothing here becomes a second editor for something the app bar
 * already edits.
 *
 * Row 1: the domain control and the result count.
 * Row 2: sort (list only), area, the applied chips, clear-all.
 *
 * Row 2 always renders — showing "no filters applied" when empty — so the bar
 * keeps a stable height and the list below does not shift under the user's
 * thumb as chips come and go.
 *
 * It is NOT `sticky`: `PageShell` renders this as a sibling of the scrolling
 * `<main>`, so it is structurally pinned. See `toolbarSlot` there for why that
 * beats a sticky child with a hardcoded offset.
 */
export function BrowseToolbar(props: Readonly<BrowseToolbarProps>) {
  const { t } = useTranslation();
  const isMap = props.viewMode === 'map';

  return (
    <div data-testid="browse-toolbar" className="px-4 py-2 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <DomainControl
          options={props.domainOptions}
          mode={isMap ? 'multi' : 'single'}
          selected={props.selectedDomains}
          onChange={props.onDomainsChange}
        />
        <span className="flex-1" />
        {props.count !== undefined && (
          <span className="text-xs font-semibold text-muted-foreground">
            {t('browse.count_listings', { count: props.count })}
          </span>
        )}
      </div>

      <div
        data-testid="toolbar-row-2"
        className="mt-2 flex flex-wrap items-center gap-2 border-t border-dashed border-border pt-2"
      >
        {/* Sort is ABSENT on the map (spec D26), not disabled: ordering is
            meaningless for a marker layer, and a disabled control invites the
            question rather than answering it. */}
        {!isMap && (
          <SortSelect
            value={props.sort}
            applied={props.sortApplied}
            nearestAvailable={props.nearestAvailable}
            basis={props.relevanceBasis}
            onChange={props.onSortChange}
          />
        )}
        <AreaSelect
          value={props.area}
          defaultCenter={props.defaultCenter}
          onChange={props.onAreaChange}
        />
        {props.chips.length > 0 ? (
          <AppliedFilterChips
            chips={props.chips}
            onRemove={props.onRemoveChip}
            onClearAll={props.onClearAll}
          />
        ) : (
          <span className="text-xs italic text-muted-foreground">
            {t('browse.no_filters')}
          </span>
        )}
      </div>
    </div>
  );
}
