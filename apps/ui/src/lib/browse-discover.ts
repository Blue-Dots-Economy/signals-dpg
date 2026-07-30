import type { Item } from '@/lib/item-api';
import type { DiscoverFacetFilter } from '@/lib/network-api';
import type { EnumFilterField } from '@/lib/enum-filters';
import { itemPassesEnumFilters } from '@/lib/enum-filters';

// ─── Toggle → discover params ───────────────────────────────────────────────
//
// Maps the LIST view's "Near me" toggle + search box + facet selections to the
// `useInfiniteBrowseItems` opts (#203 List PR Task 5). Two modes:
//
//   • Near me ON  → PROXIMITY: pass the user's location, `relevance` unset. With
//     no q/filters this stays the native distance/recency path; with q/filters
//     it runs discover WITH location (nearby search/filter).
//   • Near me OFF → RELEVANCE (the default): `relevance: true` and NO location.
//     signals-search treats any spatial clause as a HARD filter (falling back to
//     a default radius when no distance is given), so sending location here
//     would silently geo-constrain the "global" ranked feed — hence
//     `useLocation:false`. Runs discover ranked, globally.
export interface DeriveBrowseParamsInput {
  nearMe: boolean;
  search: string;
  activeFieldFilters: Record<string, string[]>;
}

export interface DerivedBrowseParams {
  relevance: boolean;
  q?: string;
  filters: DiscoverFacetFilter[];
  useLocation: boolean;
}

export function deriveBrowseParams(input: DeriveBrowseParamsInput): DerivedBrowseParams {
  const q = input.search.trim();
  const filters: DiscoverFacetFilter[] = Object.entries(input.activeFieldFilters).map(
    ([field, values]) => ({ field, values }),
  );
  return {
    relevance: !input.nearMe,
    ...(q ? { q } : {}),
    filters,
    useLocation: input.nearMe,
  };
}

// Mirrors `useInfiniteBrowseItems`' own "discover" activation condition: q OR
// filters OR relevance. When true the feed is server-filtered (text + facets),
// so the client-side filtering below must be bypassed.
export function isDiscoverActive(
  params: Pick<DerivedBrowseParams, 'relevance' | 'filters'> & { q?: string },
): boolean {
  return params.relevance || Boolean(params.q) || params.filters.length > 0;
}

// #203 List PR Task 6: whether the user has an active search query OR facet
// filter — deliberately EXCLUDES `relevance` (unlike `isDiscoverActive` above).
// This is the signal that decides which degraded-search UX the list shows when
// the discover BFF fell back to native: a query/filter that silently stopped
// being applied needs a PROMINENT banner, whereas the plain relevance default
// falling back to native recency only needs a subtle note (see
// `resolveDegradedBanner`).
export function hasActiveSearchOrFilters(
  params: Pick<DerivedBrowseParams, 'filters'> & { q?: string },
): boolean {
  return Boolean(params.q) || params.filters.length > 0;
}

export type DegradedBannerVariant = 'search_unavailable' | 'ranking_unavailable';

// #203 List PR Task 6: which degraded-search banner (if any) the list should
// show. `degraded` comes from the discover BFF's native-fallback response
// (`meta.degraded` / `source: 'native_fallback'`, threaded through
// `useInfiniteBrowseItems`); `searchOrFiltersActive` is
// `hasActiveSearchOrFilters` above. Not degraded → no banner at all.
export function resolveDegradedBanner(input: {
  degraded: boolean;
  searchOrFiltersActive: boolean;
}): DegradedBannerVariant | null {
  if (!input.degraded) return null;
  return input.searchOrFiltersActive ? 'search_unavailable' : 'ranking_unavailable';
}

// ─── Selected profile → discover anchor (#394) ──────────────────────────────
//
// The viewer's selected own-profile item id doubles as the discover "anchor"
// (`useInfiniteBrowseItems`'s `opts.anchorItemId`, threaded to signals-search's
// `intent.item.id`). `activeProfileId` is `string | null` (React state); the
// hook opt is `string | undefined`. Kept as its own tiny pure function (rather
// than inlined at the call site) so the null→undefined mapping is unit-tested
// without mounting `home-page.tsx`.
export function deriveAnchorItemId(activeProfileId: string | null): string | undefined {
  return activeProfileId ?? undefined;
}

// ─── Own-item filtering (runs UPSTREAM of buildFilteredCardsForDomain) ────────
//
// Hides the viewer's own profile from their own browse list. Kept as a distinct
// pure step so it applies in BOTH native and discover modes — it must NOT be
// bypassed by the discover path (contrast the text/enum filtering below, which
// the server has already applied on the discover path).
export function excludeOwnItems(items: Item[], ownItemIds: ReadonlySet<string>): Item[] {
  return items.filter((it) => !ownItemIds.has(it.item_id));
}

interface CardItem {
  id: string;
  domain: string;
  data: Record<string, unknown>;
}

export function itemToCardItem(item: Item): CardItem {
  return {
    id: item.item_id,
    domain: item.item_domain,
    data: { ...item.item_state, item_locations: item.item_locations },
  };
}

export interface BuildFilteredCardsOpts {
  search: string;
  mapSelectedDomains: string[];
  activeFieldFilters: Record<string, string[]>;
  enumFilterFields: EnumFilterField[];
  // #203 List PR Task 5 (correctness): when the feed was served by the discover
  // BFF, the SERVER already applied text + facet filtering — and signals-search
  // matches text semantically (embeddings), so a valid result may NOT contain
  // the literal `search` substring anywhere in `item_state`. Re-running the
  // client text/enum filters would WRONGLY drop such results, so both are
  // skipped when `discover` is true. The map-domain skip is kept (it needs no
  // server support), and own-item filtering already ran upstream.
  discover: boolean;
}

// Shared card filter for the LIST view: the map's domain multi-select, plus (on
// the native path only) free-text search + enum-field filters. Used by both the
// paged single-domain list and the "All" tab's merged paged union, so the
// predicate is defined exactly once.
export function buildFilteredCardsForDomain(
  domainId: string,
  items: Item[],
  opts: BuildFilteredCardsOpts,
): CardItem[] {
  // Map domain filter: skip this domain entirely if the filter is active and
  // this domain is not selected. Applies in BOTH modes (client-side membership
  // check, no server support needed).
  if (opts.mapSelectedDomains.length > 0 && !opts.mapSelectedDomains.includes(domainId)) {
    return [];
  }

  const cards = items.map(itemToCardItem);

  // Discover path: the server already applied text + facet filtering. Bypass
  // the client text-search AND enum-field filters (keeping only the map-domain
  // skip above) so semantic matches lacking the literal substring survive.
  if (opts.discover) {
    return cards;
  }

  let filtered = cards;

  // Text search filter (native path only)
  if (opts.search) {
    filtered = filtered.filter((item) =>
      Object.values(item.data).some((val) =>
        String(val).toLowerCase().includes(opts.search.toLowerCase()),
      ),
    );
  }

  // Enum-field filters (native path only): AND across different fields, OR
  // within a field's selected values. Absent fields on an item always pass.
  if (Object.keys(opts.activeFieldFilters).length > 0) {
    filtered = filtered.filter((item) =>
      itemPassesEnumFilters(item.data, opts.activeFieldFilters, opts.enumFilterFields),
    );
  }

  return filtered;
}
