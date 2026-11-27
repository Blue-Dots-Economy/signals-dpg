# `POST /network/item/discover`

Describes `apps/api/src/routes/v1/network/item/discover.ts`, the public list/search BFF in front of signals-search.

## Auth

Unauthenticated, like `/network/item/fetch`: it only returns the masked public `item_state`. Facet filters are resolved server-side from network config (`resolveAllowedFacetFilters`); the client's field list is never trusted.

## Primary path: signals-search

`searchSignals` calls signals-search `/v1/search`, which returns the full item row per result. Results are mapped straight to the DPG item shape in the order signals-search returned them; there is no local hydrate by id. Live-only and single-instance are signals-search's own indexing invariants.

`meta.sort_applied` is copied from signals-search. When it is absent the order is unknown (a signals-search that predates explicit sort ignores `intent.sort` entirely), so the BFF leaves it undefined rather than reporting its own guess, and logs a warning.

## Anchor retry

`anchor_item_id` (the viewer's own profile) is forwarded as `intent.item`. signals-search rejects an unusable anchor with `404 ANCHOR_NOT_FOUND` (not indexed yet) or `403 INTERACTION_NOT_ALLOWED` (the network's interaction matrix has no edge between the anchor's domain and the browsed domain). Neither is an outage, so the BFF retries once without the anchor and still answers `source: 'signals_search'`, `degraded: false`, `anchor_applied: false`. The UI already avoids sending an anchor for non-interacting domain pairs; the retry is the server-side safety net. The retry is logged because otherwise the only outward sign is a different `sort_applied`. Only a failure of the retry, or any non-anchor error, falls through to the native fallback.

## Native fallback

`searchSignals` throws when signals-search is unconfigured (`SIGNALS_SEARCH_URL` / `SIGNALS_SEARCH_API_KEY` unset), times out, or returns a non-2xx/invalid response. All three fall back to `fetchItemsAcrossInstances`, the same live-only paged fetch `/network/item/fetch` uses, so a search outage degrades the list instead of returning 5xx. `meta.source: 'native_fallback'` and `degraded: true` let the UI show its "basic matches" note.

On this path `q` and facet filters still apply (`text_search` and `item_state` in `buildWhereClause`, the same mechanisms `/markers` uses); only relevance ranking is lost, so a `relevance` request reports `sort_applied: 'newest'`. The native path has no anchor concept, so `anchor_applied` is `false`.

Multi-instance limitation: facet filters are forwarded to peers (each re-guards them), but `q` is not part of the peer `/fetch_local` body, so on a federated network a text query filters only this instance's rows.

## Sort resolution (`resolveDiscoverSort`)

Mirrors `resolveSort` in signals-search rather than sharing a package, because the two services deploy independently. It never errors: an order the request cannot have degrades to `newest`, and the response reports what was applied.

- `relevance` needs a query vector (anchor or `q`).
- `nearest` needs a centre: an ordering centre or a radius centre. A viewport bbox does not count, because deriving a centre from the rectangle would let "search this area" change the chosen sort; nearest-within-a-viewport needs the UI to send `ordering_latitude/longitude` too.
- Unspecified: `relevance` when there is an anchor or `q`, else `newest`. The BFF always sends `sort`, so this default overrides signals-search's own inference and must match it.

## Spatial modes

- Anywhere (default): no area fields, no spatial clause, and the `SIGNALS_SEARCH_DISTANCE_METERS` fallback does not apply. Sending the viewer's location on every request used to bound every list to roughly 30 km silently.
- Radius: `item_latitude/longitude` (+ optional `distance_meters`).
- Viewport: `min_lat/min_lng/max_lat/max_lng`.
- Ordering centre: `ordering_latitude/longitude` orders without filtering and never sets `meta.distance_meters`.

`meta.distance_meters` reports the effective radius (request override, then env, then `DEFAULT_SEARCH_DISTANCE_METERS`, which mirrors signals-search's default) only for a radius filter. A viewport applies no radius, and the UI shows a "within X km" note whenever this field is set.

On the wire to signals-search the radius is `body.distance_meters ?? env`, never the mirrored default: when neither is set nothing is sent, so a change to signals-search's default is not silently pinned.

## Native geo mapping (`resolveNativeGeoFilters`)

Natively, `buildDistanceOrderBy` keys off `item_latitude/longitude` only, and `buildWhereClause` adds a radius clause only when lat, lng and `radius_meters` are all present. So the same pair is both the filter centre and the distance origin:

- Viewport: the bbox filters; `nearest` with an ordering centre orders by distance from it, otherwise `created_at`.
- `nearest` with a radius area: the area's centre is used for both filter and order, so the native path filters the same circle signals-search would. Losing the separate ordering origin is an accepted native limitation.
- `nearest` without a radius: the ordering centre is sent with no radius, giving an unbounded distance-ordered set.
- Any other sort with an area: the area filters and `order_by: 'created_at'` is explicit, because the native ORDER BY otherwise keys off the mere presence of coordinates.
