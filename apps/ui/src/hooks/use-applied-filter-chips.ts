import * as React from 'react';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea } from '@/lib/browse-discover';
import type { AppliedChip } from '@/components/filters/applied-filter-chips';

export interface UseAppliedFilterChipsInput {
  search: string;
  setSearch: (next: string) => void;
  activeFieldFilters: Record<string, string[]>;
  /**
   * Applies a complete replacement facet set. A plain setter rather than
   * `Dispatch<SetStateAction<…>>`, so the bare `useState` setter cannot satisfy
   * the type: the caller must be the handler that also rewrites the `?f_*`
   * query params, or cleared facets come back on reload.
   */
  setFieldFilters: (next: Record<string, string[]>) => void;
  /** Human labels for facet keys (`field.key` → `field.label`). */
  fieldLabels: Record<string, string>;
  area: BrowseArea;
  setArea: (next: BrowseArea) => void;
}

export interface UseAppliedFilterChipsResult {
  chips: AppliedChip[];
  onRemove: (chip: AppliedChip) => void;
  onClearAll: () => void;
  /**
   * Whether anything is non-default. Not `chips.length > 0`: a non-default area
   * produces no chip. Sort is excluded (see `onClearAll`).
   */
  canClearAll: boolean;
}

/**
 * The browse toolbar's applied-filter state: chips, per-chip removal, reset and
 * "is anything applied", kept together so they agree.
 *
 * Chips cover only constraints edited elsewhere: search text (the app-bar box)
 * and facets (the filter panel). `sort` and `area` controls already show their
 * value in the same row, so they get no chip.
 */
export function useAppliedFilterChips(
  input: UseAppliedFilterChipsInput,
): UseAppliedFilterChipsResult {
  const {
    search,
    setSearch,
    activeFieldFilters,
    setFieldFilters,
    fieldLabels,
    area,
    setArea,
  } = input;

  const chips = React.useMemo<AppliedChip[]>(() => {
    const out: AppliedChip[] = [];

    const q = search.trim();
    if (q) out.push({ kind: 'search', id: 'q', label: `"${q}"`, removable: true });

    for (const [field, values] of Object.entries(activeFieldFilters)) {
      if (values.length === 0) continue;
      out.push({
        kind: 'facet',
        id: `facet:${field}`,
        label: `${fieldLabels[field] ?? field}: ${values.join(', ')}`,
        removable: true,
      });
    }

    return out;
  }, [search, activeFieldFilters, fieldLabels]);

  const onRemove = React.useCallback(
    (chip: AppliedChip) => {
      switch (chip.kind) {
        // Also clear the app-bar box, which is this chip's editor.
        case 'search':
          setSearch('');
          break;
        case 'facet': {
          const field = chip.id.slice('facet:'.length);
          const next = { ...activeFieldFilters };
          delete next[field];
          setFieldFilters(next);
          break;
        }
        case 'area':
          setArea(DEFAULT_BROWSE_AREA);
          break;
        default:
          // 'domain' is not removable — the list always needs exactly one.
          break;
      }
    },
    [setSearch, setFieldFilters, activeFieldFilters, setArea],
  );

  const onClearAll = React.useCallback(() => {
    setSearch('');
    setFieldFilters({});
    setArea(DEFAULT_BROWSE_AREA);
    // Sort is not reset: a list always has some order, and reordering results
    // while clearing filters is a change the user did not ask for.
  }, [setSearch, setFieldFilters, setArea]);

  // Sort does not count, since there is no unsorted state to clear back to.
  const canClearAll = chips.length > 0 || area.mode !== 'anywhere';

  return { chips, onRemove, onClearAll, canClearAll };
}
