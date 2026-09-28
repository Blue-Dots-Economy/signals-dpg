import * as React from 'react';
import { useTranslation } from 'react-i18next';
import { List, Map as MapIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ViewMode } from '@/engine/types';

export interface ResultsSheetHeaderProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  /** Server-reported total for the active feed; omitted while loading. */
  count?: number;
  /** The facet-panel trigger (`BrowseFiltersPanel`). */
  filtersSlot?: React.ReactNode;
  /** A control beside Filters — the map's location-source picker. */
  extraSlot?: React.ReactNode;
}

/**
 * The always-visible row of the phone results sheet (#745): a text+icon
 * Map/List switch, the live listing count, and the Filters trigger — the
 * three things the GZB prototype keeps in reach at the sheet's peek.
 *
 * A pair of `aria-pressed` buttons in a labelled group rather than a Radix
 * ToggleGroup, so the pressed state reads out the same way as the domain
 * chips above it.
 */
export function ResultsSheetHeader({
  viewMode,
  onViewModeChange,
  count,
  filtersSlot,
  extraSlot,
}: Readonly<ResultsSheetHeaderProps>) {
  const { t } = useTranslation();
  const options: { mode: ViewMode; label: string; aria: string; Icon: typeof List }[] = [
    { mode: 'map', label: t('discover.view_map'), aria: t('nav.map_view'), Icon: MapIcon },
    { mode: 'list', label: t('discover.view_list'), aria: t('nav.list_view'), Icon: List },
  ];

  return (
    // Below 360px (a 320px phone) the row cannot fit icon+text toggles, two
    // icon buttons AND "38 listings": the toggle drops its icons, gaps
    // tighten and the count drops a size, so the count stays legible.
    <div className="flex items-center gap-3 px-4 pb-3 pt-1 max-[359px]:gap-2">
      <fieldset
        aria-label={t('discover.results')}
        className="m-0 inline-flex shrink-0 overflow-hidden rounded-full border border-border p-0"
      >
        {options.map(({ mode, label, aria, Icon }) => {
          const on = viewMode === mode;
          return (
            <button
              key={mode}
              type="button"
              aria-pressed={on}
              aria-label={aria}
              onClick={() => {
                if (!on) onViewModeChange(mode);
              }}
              className={cn(
                'inline-flex h-11 items-center gap-1.5 px-3.5 text-sm font-semibold transition-colors max-[359px]:px-3',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                on ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-accent',
              )}
            >
              <Icon className="h-4 w-4 max-[359px]:hidden" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </fieldset>
      <p
        data-testid="sheet-count"
        className="min-w-0 flex-1 truncate text-sm font-semibold max-[359px]:text-xs"
        aria-live="polite"
      >
        {count === undefined ? '' : t('browse.count_listings', { count })}
      </p>
      {extraSlot}
      {filtersSlot}
    </div>
  );
}
