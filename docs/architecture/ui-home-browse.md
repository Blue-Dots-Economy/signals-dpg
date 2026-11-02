# Home page browse: map vs list

Describes `apps/ui/src/pages/home-page.tsx` and the hooks it drives
(`useMapMarkers`, `useInfiniteBrowseItems`, `useBrowseTotals`).

## Two feeds, two domain models

- **Map** is multi-domain. Its selection (`?map_domains=`, empty = every
  visible domain) decides which domains are fetched: `useMapMarkers` issues one
  `/markers` request per selected domain, scoped to the current viewport.
  Deselecting a domain saves a request.
- **List** is single-domain. A domain is always selected (`null` is only the
  transient state before the default resolves). It reads one paged feed from
  `useInfiniteBrowseItems`, in the server's order, with no client re-sort.

Switching map → list collapses the map selection to one of its domains, unless
the list's domain is already one of them.

## What reaches the server

- Free-text `search` filters both views server-side (`/markers?q=` and the
  discover feed). It matches only declared, non-private `item_state` fields.
- Enum-field facets (`?f_<field>=`) are sent as `item_state.<field>` params.
  The server silently drops a facet not declared for the queried domain, so the
  page prunes facets the current domain cannot honour.
- The profile anchor (`anchor_item_id`) is computed per target domain via the
  interaction matrix. signals-search returns 403 `INTERACTION_NOT_ALLOWED` for a
  non-interacting pair, so it is never shared across domains.
- `area` and `sort` apply to the list only. The map scopes by viewport.

## Low zoom and anonymous visitors

The map always fetches slim markers (coordinates only, capped per zoom
band by `capForZoom`) and clusters them, even at low zoom or for a visitor with no
location. Clustering bounds on-screen density, and a visitor needs to see where
items are to know where to zoom. `meta.total` reports the true match count
regardless of the cap; `MapCountPill` shows it.

## Counts

- The toolbar shows "how many match these filters" in both views: the list's
  feed total, or `useBrowseTotals` on the map.
- `MapCountPill` shows the viewport count.
- "Search this area" is offered when the map cannot draw everything in view, or
  when matching mappable items lie outside it. It applies the viewport as the
  list's area and switches to the list.
