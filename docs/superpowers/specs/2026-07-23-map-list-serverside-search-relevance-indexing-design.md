# Signals UI — map/list separation, server-side search/filter, relevance & indexing — follow-up design

**Epic:** [#203](https://github.com/Blue-Dots-Economy/signals-dpg/issues/203) — *replace the full-network `network/item/fetch` on load with a bounded, ordered, paged fetch*. This is a **follow-up** to that epic.
**Date:** 2026-07-23 · **Branch:** `feat/ui-caching-strategy` (off `feature`)
**Builds on (adopt as baseline):**
- [`2026-07-13-ui-data-fetching-at-scale-design.md`](./2026-07-13-ui-data-fetching-at-scale-design.md) — the umbrella: viewport markers endpoint, infinite-scroll list, cross-instance scatter-gather, truncation/federation indicators, anon count-first, cache-key correctness. **This doc does not restate that; it refines/extends it.**
- [`2026-07-10-ui-caching-strategy-design.md`](./2026-07-10-ui-caching-strategy-design.md) — React Query baseline (`query-client.ts`, `query-keys.ts`, `cache_ttl_seconds`).

**Related:** #196 (geocoding cache), #202 (configurable fetch limit), #117 / #171 (search & discovery / signals-search / pgvector), signals-search `POST /v1/search`.

---

## 1. Why this doc

The umbrella (#203) made the load **bounded/ordered/paged/viewport-scoped** and left three things deliberately open, marked as non-goals or "phase later":

1. **Server-side *search & filter*.** Today filtering/search is client-side over the in-memory set (`home-page.tsx` `filteredDomainItems`); once the list is paged and the map is viewport-scoped, that data is no longer fully in memory, so search/filter **must move server-side** — the umbrella did not design this.
2. **Relevance.** The umbrella ordered by geo-distance + recency and left relevance (signals-search) as P6, pluggable.
3. **Indexing.** The umbrella explicitly deferred "a PostGIS KNN index / geometry-column migration" and noted geosearch has "no supporting index" (§8 audit #8) — fine at UAT (200–1000 items), a wall at the next order of magnitude (10k–50k).

It also chose a **radius** viewport primitive (half-diagonal) and a build-time default location. This follow-up revisits both against how map-search leaders actually operate, and locks the map/list split.

**Scale target:** the next order of magnitude — **~10k–50k items** (not millions; vector tiles / server cluster-aggregation stay out of scope, §9).

**Non-goals:** re-specifying viewport fetch / paging / federation / anon count-first (umbrella owns these); vector tiles (MVT) + CDN tile caching; server-side cluster *aggregation* (returning bucket counts) — a density follow-up beyond 50k.

---

## 2. Framing — map and list are two different query problems

The core decision: **do not make one endpoint serve both views.** They answer different questions, want different indexes, and truncate differently.

| | **Map view** | **List view** |
|---|---|---|
| Question | "What's *here* (in my viewport)?" | "What's *most relevant* to me?" |
| Access pattern | spatial density | ranked feed |
| Index | PostGIS GiST (geo) | pgvector HNSW + facet filters |
| Truncation | cluster / "zoom in" | pagination |
| Payload | slim pins (id + coords) | rich, ranked cards |
| Relevance | secondary (coverage) | **primary** |
| Backend (this design) | Signals-DPG native `/markers` | **signals-search `/v1/search`** via public BFF |

### 2a. How leaders handle a shifting viewport (bbox + zoom)
Grounding for §4. A viewport is `center + zoom` ≡ a bbox; **both pan and zoom mutate the bbox, so both are viewport-change events.** Zoom additionally acts as the **level-of-detail (LOD)** dial.
- **Refetch trigger:** debounce `moveend`/`zoomend`; **refetch only when the new viewport escapes the last-fetched *padded/snapped* region** (Airbnb/Zillow "search this area" semantics). A pan inside the padded region, and any **zoom-*in*** (new bbox ⊂ old bbox), reuse cache and just **re-cluster client-side** — only pan-out / zoom-out costs a fetch.
- **Over-density by zoom:** client clustering (already shipped: `leaflet.markercluster`, Google `MarkerClusterer`) absorbs the returned set; when a viewport's `meta.total` exceeds the render cap, show **cluster + "N+ here — zoom in."** Zoom-in shrinks the bbox → count drops under the cap → self-heals (umbrella §5.3).
- **Cache key must encode zoom** (a zoomed-in result must not answer the country view) — umbrella §8 already lists a "rounded viewport / radius bucket"; this doc makes it **zoom-aware** and bbox-based.

---

## 3. Decisions & deltas vs. the umbrella

| # | Decision | Umbrella today | This follow-up |
|---|---|---|---|
| D1 | **Map query primitive = bbox** | radius (half-diagonal) | evolve `/markers` to accept a bbox (`ne`/`sw`); matches the screen exactly and is the natural, zoom-aware cache key (§4.1) |
| D2 | **Refetch rule = contained-in-padded-bbox** | debounced `moveend` + viewport bucket | formalize containment; **zoom-in ⇒ no refetch, re-cluster only** (§4.2) |
| D3 | **Display cap is zoom-dependent** | single `VITE_MAP_FETCH_LIMIT` (**25000**) | **1000 clustered / 500 individual**, tied to the cluster-disable zoom (§4.3) |
| D4 | **List powered by signals-search** | native `/network/item/fetch`, distance/recency; relevance P6 | list routes to **signals-search `/v1/search`** (semantic text + facet filters + relevance + `distanceMeters` + `meta.total`), via a public BFF, with native fallback (§5) |
| D5 | **Server-side search/filter (both views)** | client-side over in-memory set | facet filters + text move server-side; map `/markers` gains filter params (§4.4, §5) |
| D6 | **Indexing is first-class, Phase 1** | deferred non-goal | geo spatial index + facet GIN/expression indexes, driven by schema facet markers (§6) |
| D7 | **Default location = runtime config** | build-time `VITE_MAP_DEFAULT_CENTER` | move to `window.__DPG_UI_CONFIG__` runtime env; one build serves N regions (§7) |
| D8 | **Relevance-ranked map pins = Phase 2** | P6 (list relevance) | map relevance is a *density-triggered escalation* good-to-have, after the list (§4.5, §9) |

---

## 4. Map view

Native Signals-DPG only in Phase 1 — the map does **not** call the signals-search *service*, preserving its public / no-auth / edge-cacheable property.

### 4.1 bbox primitive (D1)
Extend the markers endpoint (`apps/api/src/routes/v1/network/item/markers.ts`, `MarkerResponseSchema` in `packages/schemas/src/api/item_schemas.ts`) and `FetchItemsQuerySchema` to accept a bbox — `min_lat`,`min_lng`,`max_lat`,`max_lng` — as an alternative to `item_latitude`/`item_longitude`/`radius_meters`. Keep radius for the list's "order-by-distance, no filter" path; use bbox for the map's spatial *filter*. The UI stops computing a half-diagonal radius and sends `map.getBounds()` directly.

### 4.2 Refetch rule (D2)
Client keeps the **last-fetched padded bbox** (bounds inflated ~25%, snapped to a zoom-dependent grid cell — reuse the umbrella's bucket concept, now rectangular). On debounced `moveend`/`zoomend`:
- new bounds **⊆ padded bbox** → **no fetch** (zoom-in and small pans); re-run clustering on the held set.
- new bounds **⊄ padded bbox** → fetch (auto; no "Search this area" button in Phase 1 — data is public + cached, so chattiness is cheap; revisit via telemetry).
The React Query key carries the snapped bbox **and zoom band** (extends umbrella §8 / `queryKeys.markers`).

### 4.3 Zoom-dependent caps (D3)
| Display mode | Zoom band | `MAX_MAP_PINS` | Rationale |
|---|---|---|---|
| Clustered | below cluster-disable zoom (~z<14) | **1000** | markers collapse into ~hundreds of cluster DOM nodes → more underlying points are cheap |
| Individual pins | at/above cluster-disable zoom (~z≥14) | **500** | one-to-one DOM markers; ~500 is the smooth individual-marker ceiling and avoids crowding |

Per-viewport fetch `limit = MAX_MAP_PINS + 1` for the active band. Replaces the single `VITE_MAP_FETCH_LIMIT=25000` with a two-value, zoom-banded cap (both env-overridable; `disableClusteringAtZoom` is the breakpoint).

> **Baseline correction.** Earlier drafts of this doc cited the shipped default as 5000. It is **25000** — `DEFAULT_MAP_FETCH_LIMIT` in `apps/ui/src/lib/network-api.ts`, matching `.env.example` and the server cap (`max(25000)` in `MarkersQuerySchema`/`MarkersBodySchema`). The umbrella PR's own summary also says 5000 in one place; the env table there is correct. This makes the caps above a **~25× reduction for clustered and ~50× for individual pins**, not the modest trim the 5000 figure implied — which strengthens rather than weakens the case for them. It also matters for mobile: on a ~390px viewport the shipped default is far past any usable pin density (see the mobile spec's finding F1, `docs/superpowers/specs/2026-07-27-ui-mobile-experience-design.md`).

### 4.4 Over-dense behavior (D8, Phase 1)
Fetch returns `meta.total` for the bbox. If `meta.total > MAX_MAP_PINS` → render the returned nearest set, cluster it, and show **"N+ in this area — zoom in"** (umbrella §6 truncation indicator). **Native only; no signals-search.** Map facet/text filters (D5) are sent as `item_state.*` params on `/markers` so filtering happens server-side within the bbox — the indexes in §6 make this viable at 10k–50k.

### 4.5 Relevance-ranked pins (Phase 2, good-to-have)
When a viewport is over-dense, optionally route *that viewport* through the same public BFF → signals-search (`s_dwithin` from the bbox's enclosing circle) to show the **top-N relevance-ranked** pins instead of nearest-N. Deferred: it adds the search-service dependency to the map and is only valuable once list relevance (§5) is proven. `activeProfileId` must then enter the markers cache key (already flagged in `apps/ui/CLAUDE.md` deferred note).

---

## 5. List view → signals-search via public BFF (D4, D5)

The list becomes a **ranked, searchable, filterable feed** powered by signals-search `POST /v1/search`, which already does filter-then-rank: semantic `textSearch` (BGE-M3), structured `filters` on `item_state.<field>`, `spatial` `s_dwithin`, and returns per-item `score` / `distanceMeters` + `meta.total`.

### 5.1 Access path — public BFF proxy
signals-search requires `x-api-key`; the list must work for **anonymous** users and stay edge-cacheable. So add **one public Signals-DPG endpoint** — `POST /api/v1/network/item/discover` (`apps/api/src/routes/v1/network/item/discover.ts`, no `preHandler`, mirroring the public `/network/item/fetch`) — that:
- accepts a UI-friendly body (`network`, `domain`, `item_type`, `q?`, `filters?`, `lat?`/`lng?`, `page`/`pageSize`);
- translates it into the signals-search Beckn envelope server-side, holding the key (`SIGNALS_SEARCH_URL`, `SIGNALS_SEARCH_API_KEY`);
- returns the ranked items + `meta`.

This BFF is the single place to later add auth/rate-limiting, and it is **reused by the Phase-2 map relevance escalation** (§4.5).

### 5.2 Constraints to honor
- **Page size ≤ 100** (signals-search `PaginationSchema` max) — the list page size (`VITE_PROFILE_PAGE_SIZE`, default 50) fits; do **not** exceed 100. `meta` is offset/limit only (no cursor) → keep `useInfiniteQuery` on offset.
- **Live-only** (signals-search filters `lifecycle_status='live'`) — matches the public map/list.
- **Resilience:** if signals-search is unreachable (note the known ingestion/pgvector parking risk, memory `project_pgvector_sigill_avx512`), the BFF **falls back to native `/network/item/fetch`** distance/recency ordering (umbrella §4.1) so the list degrades gracefully rather than failing. Surface a subtle "ranking unavailable" state.
- **Cross-instance:** signals-search reads the shared single-instance DB; federated scatter-gather (umbrella §4.4) does **not** apply to the discover path. For multi-instance networks, Phase 1 discover is single-instance (relevance within the served instance); federation of ranked results is a follow-up.

### 5.3 UI
- `useInfiniteBrowseItems` gains a `discover` mode: when `q` or facet filters are set (or the user is logged-in and relevance is on), it calls `/discover`; otherwise it may stay on native distance/recency browse. A **"Near me"** toggle switches ranked ↔ proximity (umbrella §9).
- Search box + facet filter panel (`components/map/map-filters-panel.tsx`, `lib/enum-filters.ts`) stop filtering in memory and instead drive the `/discover` query params. `filteredDomainItems` client filtering is retired for the paged path.

---

## 6. Indexing (D6, Phase 1)

Both Phase-1 paths need indexes at 10k–50k: the map's bbox filter and the list's facet filters (signals-search filters `items.item_state` via `JOIN`, with **no GIN today**).

### 6.1 Facet declaration (source of truth = network.json)
Extend the existing `network.json` field-role markers (Signals-DPG `examples/schemas/**/network.json` — the source of truth per memory `feedback_network_config_source_of_truth`) with a **`filterable`/facet** marker on the fields that may be filtered or free-text searched. Only declared facets get indexed — never blanket-index all of `item_state`.

### 6.2 Facet indexes
Add **GIN (`jsonb_path_ops`)** on `items.item_state`, or **expression btree** indexes on the specific declared facet paths (`(item_state->>'field')`), via a Drizzle migration (`packages/database`; partition-aware — `items` is partitioned by `item_network`). These accelerate both native `/markers` filtering and signals-search's `JOIN items` filters.

### 6.3 Geo spatial index — **correct for multi-location**
`items.item_locations` is JSONB (array; multi-location is a real feature — see `2026-06-08-multi-location-items-design.md`) with **no geometry column**; the only PostGIS `geo` + GiST lives on the separate `item_search` table. A single generated column off `item_locations[0]` would be **lossy** (misses secondary locations), so choose one of:

- **Option A (recommended, self-contained):** a normalized **location index table** — `item_location_index(item_network, item_id, geom geometry(Point,4326))`, one row per location, **GiST on `geom`**, maintained on item write/delete. Correct for multi-location; independent of the search ingestion pipeline; supports both bbox (`&&`) and radius (`ST_DWithin`). The map query joins it to `items` for slim fields.
- **Option B (lower effort, coupled):** reuse **`item_search.geo`** (already `geography(MultiPoint,4326)` + GiST, all locations, correct) via native SQL join to `items`. No new table — but couples the map to the signals-search **ingestion pipeline's health & freshness** (parked on some clusters today), and to its live-only lifecycle.

**Recommendation:** Option A for the map's robustness (map must not depend on the search pipeline); accept the write-path maintenance cost. Confirm at review (§11).

---

## 7. Location resolution (D7)

The 4-case resolver chain is already implemented and stays: **profile → browser geolocation → deployment default → hard fallback** (`apps/ui/src/hooks/use-user-location.ts`, `home-page.tsx`, `components/map/map-container.tsx`). Two changes:

1. **Move the deployment default to runtime config.** `VITE_MAP_DEFAULT_CENTER` / `VITE_MAP_DEFAULT_ZOOM` are read via `import.meta.env` (build-time), so one build can't serve multiple regions — yet the same network runs as per-region instances. Move them into `window.__DPG_UI_CONFIG__` via `getRuntimeEnv()` (`apps/ui/src/lib/runtime-env.ts`), the mechanism other UI config already uses, so the default is set per deployment without a rebuild.
2. **Fix the doc/code drift:** the fallback constant is whole-India `[20.5937, 78.9629]` while comments/`vite-env.d.ts` say "Muzaffarnagar." Reconcile to one intended value.

Anonymous + no-browser-location falls to the (now runtime-configured) deployment default, then the umbrella's anon count-first screen (§7 there) below ~zoom 8.

---

## 8. Config / env
Add to `packages/config/src/secrets.ts` **and** `turbo.json` `globalPassThroughEnv` (the two-places rule, `.claude/rules/env-vars.md`):
- `SIGNALS_SEARCH_URL`, `SIGNALS_SEARCH_API_KEY` (BFF → signals-search).
- Map caps as env: clustered/individual pin caps + cluster-disable zoom (replacing single `VITE_MAP_FETCH_LIMIT`).
- Runtime default-location keys surfaced through `getRuntimeEnv()` rather than build-time `VITE_*`.

## 9. Out of scope / follow-ups
- **Vector tiles (MVT `ST_AsMVT`) + CDN edge tile caching** — the >100k scale endgame; unnecessary at 10k–50k.
- **Server-side cluster *aggregation*** (returning bucket centroids + counts at low zoom) — the density follow-up if a single viewport routinely exceeds the caps even zoomed in (or for the identical-coordinates tail, umbrella §5.3).
- **Federated ranked discover** (relevance across multiple instances).
- **Bbox spatial op in signals-search** (it is radius-only); the Phase-2 map relevance escalation approximates the viewport with `s_dwithin`.

## 10. Testing
- **API integration (docker db + redis):** bbox filter correctness (in/out, multi-location = any-location-in-box); facet GIN/expression index used (EXPLAIN) and correct; geo index (Option A/B) correctness incl. multi-location; `/discover` translates to the signals-search envelope, maps `score`/`distanceMeters`/`meta.total`, and **falls back to native fetch** when signals-search is down; page size clamped ≤100.
- **UI unit:** contained-in-padded-bbox refetch (zoom-in ⇒ no fetch; pan-out ⇒ fetch); zoom-band cap selection (1000/500) and over-dense "N+ zoom in"; `/discover` mode toggles on q/filters and "Near me"; runtime default-location resolution across the 4 cases; cache-key includes snapped bbox + zoom (+ `activeProfileId` in Phase 2).
- `pnpm typecheck`; `pnpm --filter api test`; `pnpm --filter ui test`; verify on UP Blue Dots / Muzaffarnagar data.

## 11. Phasing (extends the umbrella P-series)
- **P-follow-1 (indexing, do first):** §6 facet declaration + GIN/expression + geo index (Option A). Unblocks fast server-side filter for both views.
- **P-follow-2 (map bbox):** §4.1–§4.4 — bbox primitive, contained-bbox refetch, zoom-dependent caps, server-side map filters. Native only.
- **P-follow-3 (list on signals-search):** §5 — public `/discover` BFF, `useInfiniteBrowseItems` discover mode, retire client filtering, native fallback.
- **P-follow-4 (location runtime config):** §7.
- **P-follow-5 (map relevance, good-to-have):** §4.5 — density-triggered relevance-ranked pins via the same BFF; add `activeProfileId` to the markers key.

## 12. Open items (confirm at review)
1. **Geo index Option A vs B** (§6.3) — self-contained location table (recommended) vs reuse `item_search.geo` (coupled to ingestion health).
2. **List backend scope** — all list traffic via `/discover` (user's stated choice) vs native for plain browse + `/discover` only on q/filter. Recommendation: honor "all via discover" with **native fallback** for resilience (§5.2).
3. **Federated ranked discover** — acceptable that Phase-1 relevance is single-instance? (§5.2)
