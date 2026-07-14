# Signals UI — data-fetching at scale + relevance — umbrella design

**Epic:** [#203](https://github.com/Blue-Dots-Economy/signals-dpg/issues/203) — *replace the full-network `network/item/fetch` on load with a bounded, ordered, paged fetch*.
**Date:** 2026-07-13 · **Branch:** `feat/ui-caching-strategy` (off `feature`)
**Absorbs:** the *paged-ordered-item-fetch* design (branch `feat/203-paged-ordered-item-fetch`, `2026-07-13-paged-ordered-item-fetch-design.md`) — its API/UI architecture is the core of this umbrella (§4–§5); this doc adds the cross-cutting concerns that design left open (partial-federation, cache-key correctness, anon count-first) and reconciles it with the caching spec.
**Companion to:** [`2026-07-10-ui-caching-strategy-design.md`](./2026-07-10-ui-caching-strategy-design.md) — that spec fixes caching *mechanics*; this one reduces the *over-fetch those mechanics cache*. Land the caching spec first; this builds on its React Query baseline (`createQueryClient`, `lib/query-keys.ts`, `cache_ttl_seconds`).
**Related (closed):** #202 (configurable fetch limit — shipped as `PROFILE_FETCH_LIMIT`), #117 / #171 (search & discovery / signals-search / pgvector).

## 1. Goal & scope

The UI was not built for scale. On load it pulls the **whole network's items** for every visible domain in one call (`fetchNetworkItems({ limit: PROFILE_FETCH_LIMIT /* 1000 */ })`) with no `offset`, no geo filtering, then sorts nearest-first **on the client**. Raising the limit hangs the site: full `item_state` (several KB/profile) × thousands + rendering that many cards/markers. This umbrella makes the load bounded, ordered server-side, paged, and viewport-scoped, tells the user when results are truncated or degraded, and leaves ordering pluggable so signals-search relevance can slot in later.

**Enabling fact:** the server already exposes the knobs. `GET /api/v1/network/item/fetch` (`apps/api/src/routes/v1/network/item/fetch_item.ts`, schema `packages/schemas/src/api/item_schemas.ts:60-121`) accepts `item_latitude` + `item_longitude` + `radius_meters`, `limit`/`offset`, `cache_ttl_seconds`, and returns `meta:{ total, limit, offset, partial, unavailable_instances }`. What's missing is server-side **ordering**, a **coords-only** path for the map, correct **cross-instance ordering**, and the UI actually using any of it.

**Parts:** §3 architecture · §4 server/API · §5 UI · §6 truncation & federation indicators · §7 anon count-first · §8 cache-key correctness · §9 relevance (phased) · §10 detail/geo caches · §11 flag-back · §12 phasing · §13 testing · §14 open items.

**Non-goals:** the caching mechanics themselves (companion spec); semantic/vector relevance in the fetch path *now* (§9, phased); server-side cluster aggregation (returning bucket counts) — a follow-up for density beyond the coord cap; a PostGIS KNN index / geometry-column migration — a performance follow-up.

---

## 2. Current-state audit (grounded in code)

| # | Behavior | Where | Problem at scale |
|---|---|---|---|
| 1 | Browse fans out **one fetch per visible domain**, each `limit: 1000`, **no `offset`, no `cache_ttl_seconds`** | `home-page.tsx:556-594`, `lib/network-api.ts` | "All" tab = `1000 × N` full-`item_state` items downloaded + rendered |
| 2 | **No viewport/bbox fetching**; load-all-then-render, clustering client-side only | `components/map/*` | Every item in the domain is on the wire regardless of what's visible |
| 3 | Ordering = server recency (`created_at DESC`) then **client** nearest-first sort | `apps/api/.../item_fetch_runtime.ts:127`, `home-page.tsx:71-82,509-513` | Server must ship everything before "nearest" can be computed |
| 4 | **No truncation indicator**; header count = `items.length` post-filter, not `meta.total` | `home-page.tsx:989-991` | Silent data loss beyond the limit |
| 5 | **`meta.partial`/`unavailable_instances` ignored** | `fetchNetworkItems` consumers | Partial federated results shown (and cached) as complete |
| 6 | `selectedApiUrl` is a single-backend switcher; instance is in **no** cache key | `lib/api-config.ts`, `lib/api-client.ts` | Switching instance serves stale cross-instance data |
| 7 | signals-search not queried by UI or API (fed one-way via Redis stream) | `apps/api/src/utils/publish_item_event.ts`; no route in `routes/v1/v1_routes.ts` | Relevance ordering needs new API surface (cross-repo) |
| 8 | Geosearch exists but has **no dedicated tests and no supporting index** | `item_fetch_runtime.ts` `buildWhereClause` (`jsonb_array_elements` + `ll_to_earth`/`earth_box`/`earth_distance`; `cube`/`earthdistance`/`postgis` installed) | Do not build on it until verified (§4.0) |

---

## 3. Architecture

Two server-ordered read paths, both driven by the resolved user location (`useUserLocation` → active-profile location, else browser geolocation, else none):

```
                 useUserLocation (profile | browser | none)
                          │
        ┌─────────────────┴──────────────────┐
   LIST view                             MAP view
   full item_state,                      coords only,
   nearest-first,                        viewport-scoped,
   infinite scroll (page ~50)            clustered, cap ~5k–10k
        │                                     │
GET /network/item/fetch               GET /network/item/markers   (new)
   lat,lng → order by distance           lat,lng,radius → filter + order
   (no radius = order only)              slim {id,domain,url,locations}
        │                                     │
        └──────────── shared runtime ─────────┘
   buildWhereClause + distance ORDER BY + cross-instance scatter-gather merge
                          │
                 marker click → fetch that item's full details by id
                                (routed by item_instance_url)
```

**Locked decisions (with the issue owner):** geo-distance + recency ordering now, relevance later; map feed = coords-only + lazy full-item on click; markers = a **separate typed endpoint**, not a flag on the existing route; list = infinite scroll ~50; reuse the existing marker clustering with a generous cap; base branch `feature`.

---

## 4. Server / API changes (`apps/api`)

### 4.0 Prerequisite — verify existing geosearch (do first)
Add an integration test (docker db + redis) inserting items with known coordinates, asserting (1) radius filter correctness (in-radius included, out excluded; multi-location items included if *any* location is in range) and (2) distance-ordering correctness (§4.1). Do **not** assume the geo query is correct until this passes.

### 4.1 Distance ordering in `fetchLocalItems` (`item_fetch_runtime.ts`)
When `item_latitude` **and** `item_longitude` are present, order by the nearest of the item's locations, then recency:
```sql
ORDER BY (
  SELECT MIN(earth_distance(ll_to_earth(:lat,:lng),
                            ll_to_earth((loc->>'lat')::float8,(loc->>'lng')::float8)))
  FROM jsonb_array_elements(item_locations) loc
) ASC NULLS LAST,
created_at DESC
```
No-location items sort last, then by recency. No coordinates supplied → keep current `created_at DESC`.

### 4.2 Relax the geo refinement (`packages/schemas/src/api/item_schemas.ts`)
`radius_meters` becomes optional relative to lat/lng, applied to `FetchItemsQuerySchema`, `FetchItemsCountBodySchema`, `FetchItemsBodySchema`, and the new markers schema:
- `lat + lng`, no radius → **order by distance, no filter** (list).
- `lat + lng + radius` → **filter by radius and order** (map).
- `radius` without lat/lng → still invalid.

### 4.3 New markers endpoint — `GET /api/v1/network/item/markers`
Coords-only projection for the map.
- **Query:** same filters as fetch (`item_network`, `item_domain`, `item_type`, `item_latitude`, `item_longitude`, `radius_meters`, `limit`, `offset`, `cache_ttl_seconds`); distance ordering as §4.1.
- **Response (slim, strictly typed) — retain the full `meta`:**
  ```jsonc
  {
    "meta": { "total": number, "limit": number, "offset": number,
              "partial": boolean, "unavailable_instances": string[] },
    "markers": [
      { "item_id": string, "item_domain": string,
        "item_instance_url": string | null,
        "item_locations": [{ "lat": number, "lng": number, "label"?: string }] }
    ]
  }
  ```
  > **Delta from the paged-ordered design:** it specified `meta:{total,limit,offset}` only. Keep **`partial` + `unavailable_instances`** here too (§6) — scatter-gather (§4.4) makes a peer being down *more* likely, and the map must not present a degraded marker set as complete.
- New runtime helper `fetchLocalMarkers` (selects only `item_id, item_domain, item_instance_url, item_locations`), reusing `buildWhereClause`, through the same cross-instance machinery. `meta.total` lets the map show a truthful "N in this area" even when the returned set is capped.

### 4.4 Cross-instance ordering (`inter_instance_fetch.ts`)
Today `buildPagePlan` concatenates instances by count-blocks, which breaks global ordering when a domain has >1 active instance. For **ordered** fetches (fetch + markers), switch to scatter-gather top-K: ask each active instance for its first `offset+limit` ordered rows; merge-sort the union by the active key — distance (recomputed on the merging instance from lat/lng + each row's `item_locations`; no schema change) when geo is present, else `created_at DESC`; slice `[offset, offset+limit)`. Degenerates to the current single-instance path when a domain has one active instance. **Preserve `meta.partial`/`unavailable_instances` through the merge** (§6).

### 4.5 Limits
`limit` max is already 1000 (#202). The markers endpoint may need a higher cap (coords are cheap) — raise the markers query `limit` max (e.g. 10000) without touching the full-fetch cap.

---

## 5. UI changes (`apps/ui`)

> **Reconciliation with the caching spec (Part C = React Query).** The paged-ordered design uses bespoke per-domain paging state + `IntersectionObserver` + `AbortController` and a map marker set decoupled from the list. This umbrella recommends expressing the same behavior in **React Query** so it stays coherent with the caching spec and Part C's key factory: `useInfiniteQuery` for the list (built-in pages/`hasNextPage`/abort/dedup) and a viewport-keyed `useQuery` for markers (built-in abort of stale requests). Same UX, one cache layer. **Open item §14** — confirm with the paged-ordered author before implementation.

### 5.1 List view (`pages/home-page.tsx`)
- Replace the single full fetch with per-domain paging keyed on `(domain, userLocation)` — `{ items, offset, total, hasMore, loading }` (or `useInfiniteQuery` pages), reset when domain or user location changes.
- Send `item_latitude`/`item_longitude` from `useUserLocation` (omit when source is `none`). Page size from `VITE_PROFILE_PAGE_SIZE` (default 50). Bottom sentinel (`IntersectionObserver`) → next page, append; guard concurrent/aborted fetches.
- **Single domain selected:** trust server order; drop the client `sortItemsByNearest` for this path.
- **"All" tab (multi-domain):** fetch a page per visible domain (each server-ordered), then client-side merge-sort the *loaded* union by distance for display; load-more advances each domain's offset. Client sort is retained **only** here (the server cannot order across domains in one query).

### 5.2 Map view (`components/map/*`, `home-page.tsx`)
- Keep the existing clustering (`google-maps-provider.tsx`, `leaflet-provider.tsx`, `cluster-breakdown.ts`).
- Feed the map from the **markers endpoint**, viewport-scoped: on debounced `moveend`, `center = map.getCenter()`, `radius = distance(center, farthest viewport corner)` (half-diagonal); fetch `{ lat, lng: center, radius_meters, item_type, limit: VITE_MAP_FETCH_LIMIT }` nearest-first, cancelling stale requests. Initial center = `userLocation` else the existing default view (`map-container.tsx`).
- The map keeps its **own** marker set, decoupled from the list's paged set (home-page state refactor — the two views no longer share `domainItems`).
- **Marker click:** lazily fetch that one item's full details by id (existing `item/fetch`/`network/item/fetch` with `item_id`), routed by `item_instance_url`; cache per-id (§10).

#### 5.3 The cap is per-viewport, not global
`VITE_MAP_FETCH_LIMIT` caps a **single viewport request**; each `moveend` replaces the marker set. So: density beyond the cap in one area (2005 in Bangalore, cap 2000) returns the 2000 nearest + `meta.total=2005` and the rest surface by **zooming in** (tighter viewport → smaller filter → below cap); separate dense areas don't consume each other's cap; only a fully-zoomed-out viewport covering everything hits the combined cap (clusters + `meta.total` stay truthful). **Exception — identical coordinates:** if items share the *exact* pin, zooming never lowers the count, so the tail beyond the cap isn't individually reachable — the server-side cluster-aggregation / "list items at this pin" follow-up addresses this; realistic data is not all one pin.

### 5.4 Config (`packages/config` + `apps/ui`)
- `VITE_PROFILE_PAGE_SIZE` — list page size (default 50).
- `VITE_MAP_FETCH_LIMIT` — map marker cap (default generous, e.g. 5000).
- Any server-side env must also go in `turbo.json` `globalPassThroughEnv` (per CLAUDE.md).

---

## 6. Truncation & federation-degradation indicators
- **Truncation:** compare `meta.total` vs rendered → **"Showing X of Y"** + "zoom in / load more" (`components/layout/content-header.tsx` + a small new component). Distinguish *no results* / *complete* / *truncated — refine/zoom*.
- **Federation degradation:** when `meta.partial` is true (or `unavailable_instances` non-empty), show **"some instances are unavailable; results may be incomplete."** Applies to list **and** markers (§4.3).
- **Cache safety:** do **not** cache a partial response as complete — short `staleTime`/`gcTime` (or tag) so a transient peer outage doesn't stick.

## 7. Anonymous browsing — count-first, defer pins
Below a country/region zoom threshold with **no location**, show the aggregate `meta.total` count + a prompt rather than a full country-wide marker pull — render pins only after zoom-to-region or location grant. This layers on §5.2's viewport fetch (the initial anon viewport at whole-India zoom would otherwise hit the cap and cluster; the count-first screen avoids even that request until the user narrows). Reuse the per-deployment default view (`VITE_MAP_DEFAULT_CENTER`/`VITE_MAP_DEFAULT_ZOOM`, `map-container.tsx:77-117`).

## 8. Cache-key correctness across the new axes
Every axis that changes the result **must** be in the React Query key (extend caching-spec `lib/query-keys.ts` `browseItems(...)` / a `markers(...)` key), or one context's data leaks into another's:

| Axis | Source | Why |
|---|---|---|
| rounded viewport / radius bucket | §5.2 | a zoomed-in result must not answer the country view (round to a zoom-dependent cell so small pans reuse entries) |
| offset / page | §5.1 | pages must not overwrite each other (`useInfiniteQuery` handles this) |
| active profile id | `activeProfileId:<net>` (`home-page.tsx:95-109`) | with relevance (§9) the ranking basis differs per profile |
| location source | profile vs browser (`hooks/use-user-location.ts`) | changes the query anchor |
| **instance / API base URL** | `lib/api-config.ts` | switching `selectedApiUrl` must bust React Query **and** the schema cache (caching spec keys schemas by network/brand, not API URL) — audit #6 |

## 9. Relevance ordering via signals-search (design now, phase later)
Ordering is **pluggable**: geo-distance + recency (§4.1) is the default order key; a relevance key slots in behind the same endpoints later. Target: a **logged-in** user's feed ranked best-match to the active profile. Cross-repo, so phased after §4–§8: add a search/relevance path in signals-dpg (a route in `routes/v1/v1_routes.ts` proxying signals-search, or a `relevance` order mode) returning ranked ids/items — the "load path and search path converge" criterion of #203, aligned with #117/#171. UI: logged-in browse uses the ranked order with a **"Near me"** toggle back to §4.1 proximity; anonymous stays proximity/recency.

## 10. Detail & geo caches
- **Per-id item detail** (marker click): cache the lazily-loaded full item by id so reopening a popup doesn't refetch.
- **(optional, minor) persistent client geo cache:** place→coord is immutable; a persistent (localStorage/IndexedDB) cache would help repeat anon visitors beyond the caching spec's session-only Part B. Low priority.

## 11. Flag-back to the caching spec
Author caching-spec **C3 (`lib/query-keys.ts`)** — and the schema-cache key (§3.1 there) — to anticipate the §8 axes (viewport bucket, offset, active profile, location source, instance URL) plus a `markers(...)` key, so the factory needn't be reworked when this lands.

## 12. Phasing / delivery order
1. **Caching spec** (companion) — React Query baseline.
2. **§4.0 geosearch verification** → **§4.1–§4.2** (distance ordering, relaxed refinement) → **§5.1** list infinite scroll (core of #203).
3. **§4.3–§4.5 markers endpoint + §5.2 map viewport fetch** + **§6 indicators**.
4. **§4.4 cross-instance scatter-gather**, **§7 anon count-first**, **§8 cache-key correctness**.
5. **§9 relevance** (cross-repo, separate delivery once the search surface exists).
6. Follow-ups (out of scope): PostGIS KNN index; server-side cluster aggregation.

## 13. Testing
- **API integration (docker db + redis):** geosearch correctness vs `item_locations` jsonb (radius in/out, multi-location); distance ordering (nearest-first, `NULLS LAST`, `created_at` tie-break); paging `meta` (total/limit/offset) + offset correctness; markers slim payload + ordering + `meta.total`; cross-instance scatter-gather merge ordering **and** `meta.partial` propagation (multi-instance fixture, one peer down).
- **UI unit:** per-domain paging / `useInfiniteQuery` state (reset on domain/location change, append, `hasMore`); infinite-scroll trigger; viewport→radius (half-diagonal) math; "All" tab cross-domain merge ordering; truncation & partial indicators; cache-key stability incl. viewport bucket + instance URL busting.
- `pnpm typecheck`; `pnpm --filter ui test`; verified on the largest instance (UP Blue Dots / Muzaffarnagar).

## 14. Open items to confirm at spec review
1. **React Query vs bespoke paging (§5).** Recommend `useInfiniteQuery` (list) + viewport-keyed `useQuery` (markers) for coherence with the caching spec — confirm with the paged-ordered-item-fetch author, since their design used bespoke state.
2. **Cross-instance scatter-gather (§4.4):** implement now (recommended — small, makes ordering correct regardless of instance count) vs. defer if all served domains are single-instance in prod.
3. **`VITE_MAP_FETCH_LIMIT` default and markers `limit` max.**
4. **Anon count-first threshold (§7):** the zoom level below which pins are deferred in favor of a count screen.

## Acceptance (maps to #203)
- [ ] Initial load issues a bounded, ordered, paged request; no full-network pull.
- [ ] List: nearest-first (or recency when no location), infinite scroll, page ~50.
- [ ] Map: viewport-scoped coords-only fetch, refetch on pan/zoom, clustered, survives 10k items.
- [ ] Marker click lazy-loads full item details (cached per id).
- [ ] Truncation ("X of Y") and partial-federation indicators shown; partial results not cached as complete.
- [ ] Switching profile / location source / instance busts the right caches.
- [ ] Reuses the configurable fetch limit (#202); no hardcoded max-100/1000 pull.
- [ ] Verified on UP Blue Dots / Muzaffarnagar data.
