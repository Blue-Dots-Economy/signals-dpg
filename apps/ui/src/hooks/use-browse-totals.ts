import * as React from 'react';
import { useQueries } from '@tanstack/react-query';
import { fetchDiscover, fetchNetworkMarkers } from '@/lib/network-api';
import { queryKeys } from '@/lib/query-keys';
import { resolveFacetFieldLabels } from '@/lib/facet-fields';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';

/** Matches the browse feeds' tier (spec §5.2) — this is the same kind of data. */
const TOTALS_STALE_TIME_MS = 90 * 1000;

/**
 * A global bbox, deliberately INSET from ±90/±180.
 *
 * Two things force this shape. A bbox is required at all because the markers
 * total WITHOUT one counts every matching item, coordinates or not — it equals
 * the discover total, so subtracting it would always yield zero. And the exact
 * ±90/±180 envelope returns 0 rows (measured: ±80/±170 → 72, ±90/±180 → 0), so
 * the corners are inset to stay inside whatever the predicate accepts. Nothing
 * real sits beyond 85° anyway — Web Mercator cannot even render it.
 */
const GLOBAL_BBOX = { min_lat: -85, min_lng: -179, max_lat: 85, max_lng: 179 } as const;

export interface UseBrowseTotalsResult {
  /**
   * Items matching the active filters, IGNORING location entirely. This is
   * the number the list view shows, so the map's filter bar can state the same
   * figure rather than a viewport-scoped one.
   *
   * "The number the list view shows" is a real constraint, not a description:
   * this call must send what the list feed sends, or the two disagree. It once
   * omitted the ANCHOR, and a typed query then counted the whole network —
   * see `anchorFor`.
   */
  total: number;
  /** Of those, how many the map can actually plot anywhere in the world. */
  mappable: number;
  /**
   * `total - mappable`: matching items that will never appear as a pin at any
   * zoom. Surfaced so a user comparing the map's viewport pill with the list's
   * count is told that some of the gap is not about the viewport at all.
   *
   * Two causes, deliberately reported as one number because the user-visible
   * consequence is identical: the item has no coordinate, or it has one but is
   * not yet in the `item_search` geo read-model the bbox predicate reads (the
   * indexing lag). Measured on blue_dot: 8 of 102, of which 4 had an empty
   * `item_locations` and 4 were simply unindexed.
   *
   * ZERO when the two counts are not comparable — see `textWithoutAnchor`.
   * A difference between two different matchers is not a missing coordinate,
   * and reporting it as one is worse than reporting nothing.
   */
  notMappable: number;
  isLoading: boolean;
}

/**
 * The filter-scoped totals behind the browse bar's count (N5).
 *
 * WHY THIS EXISTS. Three different quantities were being conflated:
 *
 *   1. items matching the filters                 (what the LIST counts)
 *   2. of those, the ones inside the map viewport (what the map PILL counts)
 *   3. of those, the ones that have a coordinate at all
 *
 * The map's filter bar was showing (2), so switching list→map made the count
 * change for a reason no label explained. The pill on the map already states
 * (2) — that is its whole job — so the bar states (1), and the (1)-vs-(3) gap
 * is reported explicitly.
 *
 * COST. Two requests per selected domain, both `limit: 1` — a count, not a
 * feed. `/discover` with no area gives (1); `/markers` with no bbox gives (3).
 * Cached at the browse tier, and only enabled when the caller needs it (the
 * list view already has (1) from the feed it is rendering).
 *
 * Facets are routed per domain exactly as in `useMapMarkers`: the server drops
 * a facet the domain does not declare, so counting without that routing would
 * report an inflated total for precisely the domains whose pins are excluded.
 */
export function useBrowseTotals(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
  filters: Record<string, unknown> = {},
  search: string = '',
  enabled: boolean = true,
  /**
   * Resolves the discover anchor for ONE target domain — the same
   * `anchorFor` the list feed uses, passed as a callback rather than an id
   * because the anchor is per target domain: signals-search enforces the
   * network's interaction matrix and 403s when the anchor's domain has no
   * defined interaction with the one being counted.
   *
   * Load-bearing for `q`, not just for ranking. With an anchor, signals-search
   * treats the typed text as a FILTER; with none, it is only a ranking signal
   * and the total comes back as the whole candidate set (contract §4).
   * Measured on the dev cluster, "Titan Retail Malleshwaram":
   *
   *   q only ................. total 135   (every provider in the network)
   *   anchor only ............ total 135
   *   q + anchor ............. total 1     (the one real match)
   *
   * Omitting it here while the list feed sent it is what produced
   * "245 listings · 244 not on the map" over a map showing a single pin: this
   * count had not narrowed, the markers count had. Narrowing follows the
   * anchor alone, not the sort, so `sort: 'newest'` below stays as it is.
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
      // `anchor` is in the key because it changes the RESULT, not just the
      // order: switching profiles can change what a typed query matches.
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
                // No area: this total is deliberately location-independent.
                sort: 'newest',
                limit: 1,
                offset: 0,
                ...(q ? { q } : {}),
                // Sent for the same reason the list feed sends it — see
                // `anchorFor`. Absent when the interaction matrix forbids it.
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
            ).then((r) => ({ kind: 'all' as const, total: r.meta.total })),
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
                // A GLOBAL bbox, not "no bbox": the spatial predicate has to
                // actually run, or this counts every matching item regardless
                // of coordinates and the difference is always zero.
                ...GLOBAL_BBOX,
                limit: 1,
                ...(q ? { q } : {}),
                ...(Object.keys(domainFilters).length > 0 ? { item_state: domainFilters } : {}),
              },
              signal,
            ).then((r) => ({ kind: 'mappable' as const, total: r.meta.total })),
          staleTime: TOTALS_STALE_TIME_MS,
          enabled: satisfiable,
        },
      ];
    }),
  });

  const signature = results.map((r) => `${r.status}:${r.dataUpdatedAt}`).join('|');

  /**
   * A typed query is counted by two DIFFERENT matchers for at least one domain.
   *
   * `/discover` narrows on `q` only when an anchor accompanies it; `/markers`
   * (the native path) always narrows, with its own substring predicate. With
   * no anchor the pair is therefore "every candidate" against "the text
   * matches", and their difference is not a count of anything — least of all
   * of items the map cannot plot, which is what the label claims.
   *
   * Reachable whenever nobody is signed in, the viewer has no profile, or the
   * interaction matrix forbids the anchor for that domain, so it is a normal
   * state rather than an edge case. `total` still stands on its own — it is
   * what the list shows for the same query — so only the difference is
   * withheld.
   */
  const textWithoutAnchor =
    q !== '' && routed.some(({ satisfiable, anchor }) => satisfiable && !anchor);

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
      // Clamped: the two counts come from separate requests, so a write
      // landing between them could otherwise show a negative "missing".
      notMappable: textWithoutAnchor ? 0 : Math.max(0, total - mappable),
      isLoading: results.some((r) => r.isLoading),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- signature captures the results' data identity
  }, [signature, textWithoutAnchor]);
}
