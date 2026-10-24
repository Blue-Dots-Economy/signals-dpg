import type { Item } from '@/lib/item-api';
import type { DiscoverFacetFilter } from '@/lib/network-api';
import type { EnumFilterField } from '@/lib/enum-filters';
import { itemPassesEnumFilters } from '@/lib/enum-filters';

// Maps the list view's search box, facets, area and sort to
// `useInfiniteBrowseItems` opts. The list always uses the discover BFF;
// `relevance` is always `true` because `isDiscoverActive` keys off it.
//
// The list is not location-bounded by default: signals-search treats a spatial
// clause as a hard filter, and the list must page through the whole network.
// The map owns location-based discovery. So:
//   - `area` defaults to `{ mode: 'anywhere' }` and sends no coordinates.
//   - `radius` is opt-in; the viewer's location is only the default centre offered.
//   - `sort: 'nearest'` orders by distance from a centre that bounds nothing.
// The opt-in area filter exists because `map-caps.ts` caps markers per
// viewport, so in a dense cell at maximum zoom the list is the escape hatch.
export type BrowseSort = 'relevance' | 'newest' | 'nearest';

export type BrowseArea =
  | { mode: 'anywhere' }
  | { mode: 'radius'; center: { lat: number; lng: number }; meters: number }
  /** The exact rectangle the map shows, sent as a signals-search `bbox`. */
  | {
      mode: 'viewport';
      bounds: { minLat: number; minLng: number; maxLat: number; maxLng: number };
    };

/** Shared so the page, the hook and their tests agree on the default. */
export const DEFAULT_BROWSE_AREA: BrowseArea = { mode: 'anywhere' };

export interface DeriveBrowseParamsInput {
  search: string;
  activeFieldFilters: Record<string, string[]>;
  area?: BrowseArea;
  sort?: BrowseSort;
}

export interface DerivedBrowseParams {
  relevance: true;
  q?: string;
  filters: DiscoverFacetFilter[];
  area: BrowseArea;
  sort: BrowseSort;
}

export function deriveBrowseParams(input: DeriveBrowseParamsInput): DerivedBrowseParams {
  const q = input.search.trim();
  const filters: DiscoverFacetFilter[] = Object.entries(input.activeFieldFilters).map(
    ([field, values]) => ({ field, values }),
  );
  return {
    relevance: true,
    ...(q ? { q } : {}),
    filters,
    area: input.area ?? DEFAULT_BROWSE_AREA,
    // `relevance` is the UI's default ask. The BFF downgrades it to `newest`
    // when there is neither an anchor nor typed text to rank by, and reports
    // what it actually applied — so the UI never labels an order it didn't get.
    sort: input.sort ?? 'relevance',
  };
}

// Mirrors `useInfiniteBrowseItems`' discover condition (q OR filters OR
// relevance). When true the feed is server-filtered, so the client-side
// filtering below is bypassed. `relevance` is a plain `boolean` so this works
// with any value.
export function isDiscoverActive(params: {
  relevance: boolean;
  filters: DiscoverFacetFilter[];
  q?: string;
}): boolean {
  return params.relevance || Boolean(params.q) || params.filters.length > 0;
}

// List note above the results. Exactly one variant applies:
//   1. `degraded` (signals-search down, native fallback): "ranking unavailable" only.
//   2. relevance applied + location: "relevant to your profile, within X km".
//   3. relevance applied, no location: "relevant to your profile".
//   4. no relevance + location: "within X km".
//   5. neither: no note.
// `locationSource` ('profile' | 'browser') maps to the copy's word
// ('profile' | 'current'); the caller localizes it via `home.location_source_*`.
export type ListNoteLocationSource = 'profile' | 'browser';

export interface ResolveListNoteInput {
  // Whether the active profile's item id is being sent as the discover anchor
  // (see `anchorItemIdForTarget`).
  hasProfileAnchor: boolean;
  /**
   * Whether the server ranked by relevance (`meta.sort_applied === 'relevance'`).
   * Required because a sent anchor may be unusable: signals-search 404s an
   * unindexed anchor, the BFF retries without it and returns
   * `sort_applied: 'newest'` with `degraded: false`.
   */
  relevanceApplied: boolean;
  // Whether a location is being sent as the discover spatial filter.
  hasLocation: boolean;
  degraded: boolean;
  // The response's `meta.distance_meters` (the radius applied); undefined on a
  // non-geo search. Without it the note omits the km figure rather than invent one.
  distanceMeters?: number;
  locationSource: ListNoteLocationSource;
}

export interface ListNoteResult {
  key: string;
  values?: { km: number; locationSource: 'profile' | 'current' };
}

export function resolveListNote(input: ResolveListNoteInput): ListNoteResult | null {
  if (input.degraded) return { key: 'home.list_ranking_unavailable' };

  // Claim profile relevance only when the anchor was sent and honoured.
  const claimsRelevance = input.hasProfileAnchor && input.relevanceApplied;

  const hasKm = input.hasLocation && input.distanceMeters !== undefined;
  if (hasKm) {
    const km = Math.round(input.distanceMeters! / 1000);
    const locationSource = input.locationSource === 'browser' ? 'current' : 'profile';
    return {
      key: claimsRelevance ? 'home.list_note_anchor_location' : 'home.list_note_location_only',
      values: { km, locationSource },
    };
  }

  if (claimsRelevance) return { key: 'home.list_note_anchor_only' };

  return null;
}

// The selected own-profile id is the discover anchor (`opts.anchorItemId` →
// signals-search `intent.item.id`). signals-search enforces the network's
// interaction matrix and 403s `INTERACTION_NOT_ALLOWED` when the anchor's domain
// has no interaction with the browsed domain, so the anchor is sent only when
// the two domains interact per the schema.

/** The slice of `DotNetworkSchema['actions']` this module needs. */
export type NetworkInteractionActions = Record<
  string,
  { interactions: ReadonlyArray<{ from_domain: string; to_domain: string }> }
>;

// True iff any action defines an interaction between `a` and `b` in either
// direction. Same-domain pairs need an explicit self-interaction.
export function domainsInteract(actions: NetworkInteractionActions, a: string, b: string): boolean {
  return Object.values(actions).some((action) =>
    action.interactions.some(
      (interaction) =>
        (interaction.from_domain === a && interaction.to_domain === b) ||
        (interaction.from_domain === b && interaction.to_domain === a),
    ),
  );
}

export interface AnchorItemIdForTargetInput {
  activeProfileId: string | null;
  activeProfileDomain: string | null;
  targetDomain: string;
  actions: NetworkInteractionActions;
}

// The viewer's selected profile id when its domain may interact with the
// target domain; otherwise `undefined` (no anchor, avoiding the 403).
export function anchorItemIdForTarget(input: AnchorItemIdForTargetInput): string | undefined {
  if (!input.activeProfileId || !input.activeProfileDomain) return undefined;
  if (!domainsInteract(input.actions, input.activeProfileDomain, input.targetDomain)) return undefined;
  return input.activeProfileId;
}

// Hides the viewer's own profiles from their browse list. Runs before
// `buildFilteredCardsForDomain` and in both native and discover modes.
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
  activeFieldFilters: Record<string, string[]>;
  enumFilterFields: EnumFilterField[];
  // True when the discover BFF served the feed: the server already applied text
  // and facet filtering, and matches text semantically, so a valid result may
  // lack the literal search string. Client text/enum filters are then skipped.
  discover: boolean;
}

// List-view card filter: free-text search and enum-field filters, on the native
// path only. The map's domain selection does not affect the list.
export function buildFilteredCardsForDomain(
  _domainId: string,
  items: Item[],
  opts: BuildFilteredCardsOpts,
): CardItem[] {
  const cards = items.map(itemToCardItem);

  // Discover path: the server already filtered; keep semantic matches that lack
  // the literal substring.
  if (opts.discover) {
    return cards;
  }

  let filtered = cards;

  if (opts.search) {
    filtered = filtered.filter((item) =>
      Object.values(item.data).some((val) =>
        String(val).toLowerCase().includes(opts.search.toLowerCase()),
      ),
    );
  }

  // AND across fields, OR within a field's values (see itemPassesEnumFilters).
  if (Object.keys(opts.activeFieldFilters).length > 0) {
    filtered = filtered.filter((item) =>
      itemPassesEnumFilters(item.data, opts.activeFieldFilters, opts.enumFilterFields),
    );
  }

  return filtered;
}
