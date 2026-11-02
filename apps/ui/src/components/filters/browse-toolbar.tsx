import { useTranslation } from 'react-i18next';
import { AppliedFilterChips } from './applied-filter-chips';
import { SortSelect } from './sort-select';
import * as React from 'react';
import { DomainControl } from './domain-control';
import { LocationSelect } from './location-select';
import { LocationSourceSelect } from './location-source-select';
import type { AppliedChip } from './applied-filter-chips';
import type { DomainOption } from './domain-control';
import type { BrowseArea, BrowseSort } from '@/lib/browse-discover';
import type { PreferredLocationSource } from '@/hooks/use-user-location';
import type { ViewMode } from '@/engine/types';

export interface BrowseToolbarProps {
  viewMode: ViewMode;
  /** Server-reported total for the active feed; omitted while loading. */
  count?: number;
  /**
   * Map view only: matching items the map cannot plot at any zoom (no
   * coordinate, or not yet in the geo read-model). Explains the gap between
   * this count and the viewport pill that zooming out never closes.
   */
  notMappable?: number;
  sort: BrowseSort;
  /** `meta.sort_applied` — what the server actually did. */
  sortApplied?: BrowseSort;
  /** A response arrived reporting no order at all — see `SortSelect`. */
  sortUnreported?: boolean;
  nearestAvailable: boolean;
  /** False when the server cannot rank by relevance; see `SortSelect`. */
  relevanceAvailable?: boolean;
  relevanceBasis: 'profile' | 'search' | null;
  onSortChange: (next: BrowseSort) => void;
  domainOptions: DomainOption[];
  selectedDomains: string[];
  onDomainsChange: (next: string[]) => void;
  /** The facet-panel trigger. */
  filtersSlot?: React.ReactNode;
  area: BrowseArea;
  /**
   * The location source the viewer asked for. Used on both views, unlike
   * `area`: on the map it centres the map (`LocationSourceSelect`).
   */
  locationSource: PreferredLocationSource;
  /**
   * The source actually in force, which can differ from `locationSource`; see
   * `LocationSourceSelect`. Map only, since the list control shows a radius.
   */
  effectiveLocationSource: PreferredLocationSource;
  onLocationSourceChange: (next: PreferredLocationSource) => void;
  profileLocationAvailable: boolean;
  browserLocationAvailable: boolean;
  /** Centre offered when the user picks a radius; null when none resolves. */
  defaultCenter: { lat: number; lng: number } | null;
  onAreaChange: (next: BrowseArea) => void;
  /**
   * Chips for constraints edited elsewhere (search text, facets). Sort and
   * area have no chip because their controls in this row already show them.
   */
  chips: AppliedChip[];
  onRemoveChip: (chip: AppliedChip) => void;
  onClearAll: () => void;
  /**
   * Whether anything is non-default. Not `chips.length > 0`: sort and area can
   * be non-default without a chip, and clear-all must still be reachable.
   */
  canClearAll: boolean;
}

/**
 * The browse state bar: domain, sort (list only), location, the facet-panel
 * trigger, applied chips, clear-all and the count, in one row. Actions on the
 * results (bulk-select) live over the content instead.
 *
 * It always renders so its height is stable and the list does not shift as
 * chips come and go. It is not `sticky`; `PageShell` pins it via `toolbarSlot`.
 *
 * Design: docs/architecture/ui-components-browse-controls.md
 */
export function BrowseToolbar(props: Readonly<BrowseToolbarProps>) {
  const { t } = useTranslation();
  const isMap = props.viewMode === 'map';

  return (
    <div data-testid="browse-toolbar" className="px-4 py-2 sm:px-6">
      <div
        data-testid="toolbar-row-2"
        className="flex flex-wrap items-center gap-2"
      >
        <DomainControl
          options={props.domainOptions}
          // The map is multi-domain; the list is single-select on the one
          // domain driving its feed.
          mode={isMap ? 'multi' : 'single'}
          selected={props.selectedDomains}
          onChange={props.onDomainsChange}
        />
        {/* Pushes the controls right from `sm` up only; on a phone it would
            split Sort from Location and Filters across two rows. */}
        <span className="hidden flex-1 sm:block" />
        {/* Sort, Location and Filters are one flex item so they wrap together
            on a phone. `sm:contents` returns them to the parent row from `sm`
            up. */}
        <span className="flex shrink-0 items-center gap-2 sm:contents">
        {/* Sort is absent on the map, not disabled: ordering is meaningless
            for a marker layer. */}
        {!isMap && (
          <span data-tour="browse-sort" className="inline-flex">
          <SortSelect
            value={props.sort}
            applied={props.sortApplied}
            appliedUnreported={props.sortUnreported}
            nearestAvailable={props.nearestAvailable}
            relevanceAvailable={props.relevanceAvailable}
            nearestFromLabel={t(
              props.locationSource === 'browser'
                ? 'browse.location_from_browser'
                : 'browse.location_from_profile',
            ).toLowerCase()}
            basis={props.relevanceBasis}
            onChange={props.onSortChange}
          />
          </span>
        )}
        {/* The radius is absent on the map: the viewport is the map's spatial
            filter (`useMapMarkers` ignores `area`). The source half renders
            below for the map. */}
        {!isMap && (
          <span data-tour="browse-location" className="inline-flex">
          <LocationSelect
            value={props.area}
            sort={props.sort}
            source={props.locationSource}
            onSourceChange={props.onLocationSourceChange}
            profileAvailable={props.profileLocationAvailable}
            browserAvailable={props.browserLocationAvailable}
            center={props.defaultCenter}
            onChange={props.onAreaChange}
          />
          </span>
        )}
        {/* The map keeps the location source: it decides where the map opens
            and where "You are here" sits. */}
        {isMap && (
          <span data-tour="map-location" className="inline-flex">
          <LocationSourceSelect
            value={props.locationSource}
            effectiveValue={props.effectiveLocationSource}
            onChange={props.onLocationSourceChange}
            profileAvailable={props.profileLocationAvailable}
            browserAvailable={props.browserLocationAvailable}
          />
          </span>
        )}
        {props.filtersSlot && (
          <span data-tour="browse-filters" className="inline-flex">
            {props.filtersSlot}
          </span>
        )}
        </span>
        {props.chips.length > 0 && (
          <AppliedFilterChips chips={props.chips} onRemove={props.onRemoveChip} />
        )}
        {props.canClearAll ? (
          <button
            type="button"
            onClick={props.onClearAll}
            className="inline-flex items-center text-xs font-bold text-destructive hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
          >
            {t('browse.clear_all')}
          </button>
        ) : (
          <span className="text-xs italic text-muted-foreground">
            {t('browse.no_filters')}
          </span>
        )}
        {props.count !== undefined && (
          /* The divider is a border on the count, not its own element, so it
             cannot wrap apart from the count. `sm:` only: below that the count
             wraps onto its own line. */
          <span
            data-testid="toolbar-count"
            className="flex flex-wrap items-baseline justify-end gap-x-1.5 text-xs sm:border-l sm:border-border sm:pl-2.5"
          >
            <span className="font-semibold text-muted-foreground">
              {t('browse.count_listings', { count: props.count })}
            </span>
            {props.notMappable !== undefined && props.notMappable > 0 && (
              <span data-testid="not-mappable-note" className="text-muted-foreground/80">
                {t('browse.count_not_mappable', { count: props.notMappable })}
              </span>
            )}
          </span>
        )}
      </div>
    </div>
  );
}
