import * as React from 'react';
import { DEFAULT_BROWSE_AREA } from '@/lib/browse-discover';
import type { BrowseArea, BrowseSort } from '@/lib/browse-discover';
import type { AppliedChip } from '@/components/filters/applied-filter-chips';

export interface UseAppliedFilterChipsInput {
  search: string;
  setSearch: (next: string) => void;
  activeFieldFilters: Record<string, string[]>;
  setFieldFilters: React.Dispatch<React.SetStateAction<Record<string, string[]>>>;
  area: BrowseArea;
  setArea: (next: BrowseArea) => void;
  sort: BrowseSort;
  setSort: (next: BrowseSort) => void;
}

export interface UseAppliedFilterChipsResult {
  chips: AppliedChip[];
  onRemove: (chip: AppliedChip) => void;
  onClearAll: () => void;
  /**
   * Whether anything at all is non-default. Deliberately NOT
   * `chips.length > 0`: sort and area can be non-default while producing no
   * chip, and clear-all must stay reachable then.
   */
  canClearAll: boolean;
}

/**
 * The browse toolbar's applied-filter state (#645 §4.1).
 *
 * Lives in a hook rather than inside `HomePage` because it is one cohesive
 * unit — the chip list, the per-chip removal, the reset, and "is anything
 * applied" all have to agree, and adding a constraint means touching this file
 * and nowhere else. It also keeps a loop, a switch and a boolean chain out of
 * an already-large page component.
 *
 * Chips cover only constraints whose EDITOR is elsewhere: search text (the
 * app-bar box) and facets (the filter panel). `sort` and `area` get no chip —
 * their own controls sit in the same toolbar row already showing their value,
 * so a chip repeating it renders as a visible duplicate.
 */
export function useAppliedFilterChips(
  input: UseAppliedFilterChipsInput,
): UseAppliedFilterChipsResult {
  const { search, setSearch, activeFieldFilters, setFieldFilters, area, setArea, sort, setSort } =
    input;

  const chips = React.useMemo<AppliedChip[]>(() => {
    const out: AppliedChip[] = [];

    const q = search.trim();
    if (q) out.push({ kind: 'search', id: 'q', label: `"${q}"`, removable: true });

    for (const [field, values] of Object.entries(activeFieldFilters)) {
      if (values.length === 0) continue;
      out.push({
        kind: 'facet',
        id: `facet:${field}`,
        label: `${field}: ${values.join(', ')}`,
        removable: true,
      });
    }

    return out;
  }, [search, activeFieldFilters]);

  const onRemove = React.useCallback(
    (chip: AppliedChip) => {
      switch (chip.kind) {
        // Spec D25: this chip's editor is the app-bar box. Dropping the query
        // while leaving the typed text sitting in that box would be a lie.
        case 'search':
          setSearch('');
          break;
        case 'facet': {
          const field = chip.id.slice('facet:'.length);
          setFieldFilters((prev) => {
            const next = { ...prev };
            delete next[field];
            return next;
          });
          break;
        }
        case 'area':
          setArea(DEFAULT_BROWSE_AREA);
          break;
        case 'sort':
          setSort('relevance');
          break;
        default:
          // 'domain' is not removable — the list always needs exactly one.
          break;
      }
    },
    [setSearch, setFieldFilters, setArea, setSort],
  );

  const onClearAll = React.useCallback(() => {
    setSearch('');
    setFieldFilters({});
    setArea(DEFAULT_BROWSE_AREA);
    setSort('relevance');
  }, [setSearch, setFieldFilters, setArea, setSort]);

  const canClearAll = chips.length > 0 || sort !== 'relevance' || area.mode !== 'anywhere';

  return { chips, onRemove, onClearAll, canClearAll };
}
