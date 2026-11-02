import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchDiscover, fetchNetworkMarkers } from '@/lib/network-api';
import { queryKeys } from '@/lib/query-keys';
import { resolveFacetFieldLabels } from '@/lib/facet-fields';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';

/** Same freshness tier as the browse feeds. */
const TOTALS_STALE_TIME_MS = 90 * 1000;

/**
 * A global bbox, inset from ±90/±180. A bbox makes the markers count skip items
 * without coordinates; the exact ±90/±180 envelope returns 0 rows.
 */
const GLOBAL_BBOX = { min_lat: -85, min_lng: -179, max_lat: 85, max_lng: 179 } as const;

export interface UseBrowseTotalsResult {
  /**
   * Items matching the active filters, ignoring location: the number the list
   * view shows. Must be requested exactly as the list feed requests it,
   * including the anchor.
   */
  total: number;
  /** Of those, how many the map can plot anywhere in the world. */
  mappable: number;
  /**
   * `total - mappable`: matching items that never appear as a pin (no
   * coordinate, or not yet indexed in `item_search`). Zero when a typed query
   * was counted by two different matchers; see `textWithoutAnchor`.
   */
  notMappable: number;
  isLoading: boolean;
}

/**
 * Filter-scoped totals behind the browse bar's count: the list's figure plus how
 * many of those items the map can never plot. Two `limit: 1` requests per
 * domain, cached at the browse tier.
 *
 * Design: docs/architecture/ui-browse-totals.md
 */
export function useBrowseTotals(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
  filters: Record<string, unknown> = {},
  search: string = '',
  enabled: boolean = true,
  /**
   * Resolves the discover anchor per target domain, the same `anchorFor` the
   * list feed uses (signals-search 403s an anchor whose domain has no
   * interaction with the counted one). Required for `q` to filter: without an
   * anchor, signals-search only ranks by the text and returns the whole
   * candidate set.
   */
  anchorFor?: (domain: string) => string | undefined,
): UseBrowseTotalsResult {
  const q = search.trim();
  const active = network && enabled ? domains : [];

  const routed = React.useMemo(() => {
    const activeFields = Object.keys(filters);
    return active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      const anchor = anchorFor?.(domain.id);
      if (activeFields.length === 0) {
        return {
          domain,
          itemType,
          anchor,
          filters: {} as Record<string, unknown>,
          satisfiable: true,
        };
      }
      const declared = resolveFacetFieldLabels([domain]);
      const applicable: Record<string, unknown> = {};
      let satisfiable = true;
      for (const field of activeFields) {
        if (field in declared) applicable[field] = filters[field];
        else satisfiable = false;
      }
      return { domain, itemType, anchor, filters: applicable, satisfiable };
    });
  }, [active, filters, anchorFor]);

  const results = useQueries({
    queries: routed.flatMap(({ domain, itemType, anchor, filters: domainFilters, satisfiable }) => {
      // `anchor` is in the key because it changes what a typed query matches.
      const keyBase = { filters: domainFilters, q, satisfiable, anchor: anchor ?? null };
      return [
        {
          queryKey: queryKeys.browseTotals(network!.id, domain.id, { ...keyBase, kind: 'all' }),
          queryFn: async ({ signal }: { signal: AbortSignal }) =>
            fetchDiscover(
              {
                item_network: network!.id,
                item_domain: domain.id,
                item_type: itemType,
                // No area: this total is location-independent.
                sort: 'newest',
                limit: 1,
                offset: 0,
                ...(q ? { q } : {}),
                // Absent when the interaction matrix forbids it.
                ...(anchor ? { anchor_item_id: anchor } : {}),
                ...(Object.keys(domainFilters).length > 0
                  ? {
                      filters: Object.entries(domainFilters).map(([field, values]) => ({
                        field,
                        values: values as string[],
                      })),
                    }
                  : {}),
              },
              signal,
            ).then((r) => ({
              kind: 'all' as const,
              total: r.meta.total,
              // What the server did with the anchor; see `textWithoutAnchor`.
              anchorApplied: r.meta.anchor_applied,
            })),
          staleTime: TOTALS_STALE_TIME_MS,
          enabled: satisfiable,
        },
        {
          queryKey: queryKeys.browseTotals(network!.id, domain.id, { ...keyBase, kind: 'mappable' }),
          queryFn: async ({ signal }: { signal: AbortSignal }) =>
            fetchNetworkMarkers(
              {
                item_network: network!.id,
                item_domain: domain.id,
                item_type: itemType,
                // A global bbox, so the spatial predicate runs and items without
                // coordinates are excluded.
                ...GLOBAL_BBOX,
                limit: 1,
                ...(q ? { q } : {}),
                ...(Object.keys(domainFilters).length > 0 ? { item_state: domainFilters } : {}),
              },
              signal,
            ).then((r) => ({
              kind: 'mappable' as const,
              total: r.meta.total,
              anchorApplied: false as boolean,
            })),
          staleTime: TOTALS_STALE_TIME_MS,
          enabled: satisfiable,
        },
      ];
    }),
  });

  const signature = results.map((r) => `${r.status}:${r.dataUpdatedAt}`).join('|');

  /**
   * A typed query counted by two different matchers. `/discover` narrows on `q`
   * only when an anchor was applied; `/markers` always narrows. signals-search
   * can reject an anchor (the BFF retries without it and still returns 200),
   * so this reads `meta.anchor_applied` from the response, not what was sent.
   * Only the difference is withheld; `total` still stands.
   */
  const textWithoutAnchor =
    q !== '' &&
    results.some((r) => r.data?.kind === 'all' && !r.data.anchorApplied);

  return React.useMemo(() => {
    let total = 0;
    let mappable = 0;
    for (const r of results) {
      if (!r.data) continue;
      if (r.data.kind === 'all') total += r.data.total;
      else mappable += r.data.total;
    }
    return {
      total,
      mappable,
      // Clamped: the counts come from separate requests, so a write between
      // them could make the difference negative.
      notMappable: textWithoutAnchor ? 0 : Math.max(0, total - mappable),
      isLoading: results.some((r) => r.isLoading),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature captures the results' data identity
  }, [signature, textWithoutAnchor]);
}
