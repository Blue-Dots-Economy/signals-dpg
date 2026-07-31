# #203 P4 — Markers Endpoint + Viewport-Scoped Map + Lazy Detail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver P4 of #203: a slim coords-only **markers endpoint** (`GET /api/v1/network/item/markers`), and rewire the home-page **map** to fetch markers **viewport-scoped** (so it survives 10k+ items) with **lazy per-id detail on marker click** and a **federation-degradation indicator** — decoupling the map from the list's paged set and removing the last full `useBrowseItems` fetch.

**Architecture:** Server: a new slim runtime helper `fetchLocalMarkers` (selects only `item_id, item_domain, item_instance_url, item_locations`, reusing `buildWhereClause` + the §4.1 distance `ORDER BY`), a `fetchMarkersAcrossInstances` that reuses `buildPagePlan` + the existing count step (projection-independent) and returns the full `meta` (incl. `partial`/`unavailable_instances`), and two routes (public aggregate GET + peer `markers_local` POST). UI: `MapView` stays backward-compatible (tourist app shares it) and gains an optional debounced `onViewportChange(center, radiusMeters)` callback; the home-page map is fed by a viewport-keyed `useMapMarkers` query, renders slim markers, and lazily fetches full item detail by id (cached per-id, §10) for popups. Once the map no longer needs `domainItems`, the full `useBrowseItems` fetch is removed from the page.

**Tech Stack:** Fastify + Drizzle + Postgres (`earthdistance`) server; React 19 + `@tanstack/react-query` v5 + Leaflet/Google map providers + Vitest client.

**Epic context:** P4 of #203 (`docs/superpowers/specs/2026-07-13-ui-data-fetching-at-scale-design.md` §4.3, §4.5, §5.2, §5.4, §6 federation). Built on P3 (distance ordering §4.1 + relaxed schema §4.2 + list paging §5.1) on branch `feat/ui-caching-strategy` (PR #295). **P5** (§4.4 cross-instance scatter-gather ordering + `meta.partial` through the merge + §7 anon count-first + §8 cache-key/instance-URL) and **P6** (§9 relevance, cross-repo) follow.

**Out of scope (do NOT do here):** §4.4 scatter-gather ordering — the markers aggregate uses the SAME count-block concatenation as the item fetch (P5 reworks both together); §7 anon count-first; §8 instance-URL busting. Do not change the list paging (P3) or the tourist app's map behavior.

## Global Constraints

- **Branch:** `feat/ui-caching-strategy` (PR #295). Do NOT commit to `feature`/`develop`.
- **Server:** ESM, strict TS, no `any`. Routes never throw (`reply.code(N).send({error,message})`). Reuse `buildWhereClause` + the §4.1 `ORDER BY` (do NOT duplicate the distance SQL — factor a shared clause if needed). Peer route guarded by `peer_instance_guard`, `lifecycle_filter: 'live_only'` on public paths.
- **Markers response shape (spec §4.3), exact:** `{ meta: { total, limit, offset, partial, unavailable_instances }, markers: [{ item_id, item_domain, item_instance_url, item_locations }] }`. No `item_state`.
- **Limits (spec §4.5, §14.3):** markers query `limit` max **10000** (coords are cheap); the full-fetch cap stays **1000** (unchanged). `VITE_MAP_FETCH_LIMIT` default **5000**.
- **Viewport→radius (spec §5.2):** on debounced `moveend`, `center = map.getCenter()`, `radius_meters = distance(center, farthest viewport corner)` (half-diagonal). Nearest-first (lat/lng = center). Cancel stale requests.
- **MapView backward compatibility:** `MapView` is imported by BOTH `home-page.tsx` and `tourist/tourist-map.tsx`. All new props are OPTIONAL; the tourist path (which passes fully-resolved card `items` and its own `renderPopup`) must behave identically. Do NOT change existing MapView prop semantics.
- **UI caching tiers:** markers query is a browse-feed-like tier — `staleTime` ~90s, pass `cache_ttl_seconds`; per-id detail is own-ish/config-ish — cache per id (§10), `staleTime` ~5 min. Keys via `lib/query-keys.ts` (`markers(...)` exists; add a `itemDetail` key).
- **Location-less items:** the markers endpoint (radius filter / distance order) only returns items that have `item_locations`; items with none simply do not appear on the map (correct — they have no place on a map). Do not client-geocode in the endpoint-fed path.

## Design decisions (FLAGGED for review)

1. **Map enum filtering vs slim markers (the key fork).** The home-page map today filters client-side over full card data (`mapSelectedFields` → `itemPassesEnumFilters`). Slim markers carry no `item_state`, so client-side map filtering can't run. **Decision for P4:** pass the map's selected enum fields to the markers query as a server-side `item_state` filter for **single-value-per-field** selections (the common case; `buildWhereClause` already supports `item_state @> jsonb`). **Multi-value-per-field** map filtering is **deferred** (an `item_state`-any/OR filter is a separate change) and documented as a known limitation. *If you'd rather keep full multi-value map filtering now, the alternative is a non-slim markers projection (include the filterable field values) — say so and I'll restructure.*
2. **Marker popups become lazy.** Instead of a rich popup from pre-loaded data, clicking a marker fetches that one item's full detail by id (cached per-id, §10). Brief transient loading state in the popup.
3. **`useBrowseItems`/`domainItems` removed from home-page** once the map is on markers (Task 7) — this resolves the P3-deferred minors (All-tab loading-flash, header-count-vs-list-total). The header "count" is re-sourced from the list/markers totals.
4. **Tourist app untouched** — it keeps passing resolved card items + its own popup to the shared `MapView`; only optional props are added.

## File Structure

- `packages/schemas/src/api/item_schemas.ts` — **modify**: add `MarkersQuerySchema`/`MarkersBodySchema` (limit max 10000) + `MarkerResponseSchema`; apply `withGeoSearchRefinement`.
- `apps/api/src/utils/item_fetch_runtime.ts` — **modify**: add `fetchLocalMarkers` (slim select + shared order clause).
- `apps/api/src/utils/inter_instance_fetch.ts` — **modify**: export `getInstanceCount`; add `fetchMarkersAcrossInstances` + a markers page-cache-key + a slim peer fetch.
- `apps/api/src/routes/v1/network/item/markers.ts` — **create**: `GET /item/markers` (aggregate) + `POST /item/markers_local` (peer).
- `apps/api/src/routes/v1/network/item/*` route registration — **modify**: register the markers plugin.
- `apps/api/src/utils/__tests__/geosearch_markers.integration.test.ts` — **create**: slim payload + radius + ordering + meta.
- `apps/ui/src/lib/network-api.ts` — **modify**: `fetchNetworkMarkers` + `MarkersResponse`/query types + `resolveMapFetchLimit`/`MAP_FETCH_LIMIT`.
- `apps/ui/src/lib/query-keys.ts` — **modify**: add `itemDetail(networkId, itemId)`.
- `apps/ui/src/lib/geo/distance.ts` — **modify/reuse**: viewport half-diagonal helper (reuse existing `distance` if present).
- `apps/ui/src/hooks/use-map-markers.ts` + test — **create**: viewport-keyed markers query.
- `apps/ui/src/hooks/use-item-detail.ts` + test — **create**: per-id lazy detail (§10).
- `apps/ui/src/components/map/map-container.tsx` — **modify**: optional `onViewportChange` (debounced moveend, half-diagonal radius); no contract break.
- `apps/ui/src/pages/home-page.tsx` — **modify**: map fed by `useMapMarkers`; lazy popup via `useItemDetail`; server-side map enum filter; federation indicator; remove `useBrowseItems`/`domainItems` (Task 7).

---

### Task 1: Markers schema + `fetchLocalMarkers` runtime helper + limits

**Files:**
- Modify: `packages/schemas/src/api/item_schemas.ts`
- Modify: `apps/api/src/utils/item_fetch_runtime.ts`
- Modify: `apps/api/src/utils/__tests__/geosearch_radius.integration.test.ts` (add a markers-shape ordering/filter case) OR create `geosearch_markers.integration.test.ts`

**Interfaces:**
- Produces (schemas): `MarkersQuerySchema` (= `FetchItemsSchemaBase` minus `item_state`? keep `item_state` for the §D1 server-side filter; `limit` max **10000**, default e.g. 200) with `withGeoSearchRefinement`; `MarkersBodySchema` (peer, with limit/offset); `MarkerResponseSchema = z.object({ item_id, item_domain, item_instance_url: z.string().nullable(), item_locations: ItemLocationsArray })`.
- Produces (runtime): `fetchLocalMarkers(filters: ItemFetchFilters): Promise<{ meta:{total,limit,offset}, markers: MarkerRow[] }>` where `MarkerRow = { item_id, item_domain, item_instance_url, item_locations }`. Same WHERE + ORDER BY as `fetchLocalItems`, slim projection.

- [ ] **Step 1: Add the markers schemas**

In `packages/schemas/src/api/item_schemas.ts`, after the fetch schemas add:

```ts
const MarkersSchemaBase = FetchItemsSchemaBase.extend({
  // Coords are cheap — allow a much higher cap than the 1000 full-fetch cap.
  limit: z.coerce.number().int().min(1).max(10000).default(200),
});

export const MarkersQuerySchema = withGeoSearchRefinement(MarkersSchemaBase);
export const MarkersBodySchema = withGeoSearchRefinement(
  MarkersSchemaBase.extend({
    limit: z.number().int().min(1).max(10000),
    offset: z.number().int().min(0),
    cache_ttl_seconds: z.number().int().positive().optional(),
  })
);

export const MarkerResponseSchema = z.object({
  item_id: z.uuid(),
  item_domain: z.string(),
  item_instance_url: z.url().nullable(),
  item_locations: ItemLocationsArray,
});
```

Export them from the package index if the barrel requires explicit re-export (check `packages/schemas/src/index.ts`).

- [ ] **Step 2: Add `fetchLocalMarkers` (slim) — TDD via integration**

Add a markers assertion to the geosearch integration suite (reuse the seeded rows): assert `fetchLocalMarkers` returns only the slim fields, applies the radius filter, orders nearest-first, and `meta.total` matches. RED first (function absent), then implement.

In `apps/api/src/utils/item_fetch_runtime.ts`, factor the §4.1 order clause into a small helper (removing the duplication the P3 review flagged) and add:

```ts
const markerColumns = {
  item_id: items.item_id,
  item_domain: items.item_domain,
  item_instance_url: items.item_instance_url,
  item_locations: items.item_locations,
};

export async function fetchLocalMarkers(filters: ItemFetchFilters) {
  const whereClause = buildWhereClause(filters);
  const total = await countLocalItems(filters);
  const markers = await db
    .select(markerColumns)
    .from(items)
    .where(whereClause)
    .orderBy(buildDistanceOrderBy(filters)) // shared with fetchLocalItems
    .limit(filters.limit)
    .offset(filters.offset);
  return {
    meta: { total, limit: filters.limit, offset: filters.offset },
    markers,
  };
}
```

where `buildDistanceOrderBy(filters)` returns the same conditional `sql` clause fetchLocalItems now uses (extract it; update `fetchLocalItems` to call it — behavior-identical, closes the P3 duplication minor).

- [ ] **Step 3: Run integration + unit + typecheck; commit.**

Run: `pnpm --filter api exec vitest run --config vitest.integration.config.ts src/utils/__tests__/geosearch_*.integration.test.ts` → PASS. `pnpm --filter api test` + `pnpm typecheck` → PASS.

```bash
git add packages/schemas/src/api/item_schemas.ts apps/api/src/utils/item_fetch_runtime.ts apps/api/src/utils/__tests__/*.integration.test.ts
git commit -m "feat(api): markers schema + fetchLocalMarkers slim projection (#203 §4.3/§4.5)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Markers cross-instance aggregate + routes

**Files:**
- Modify: `apps/api/src/utils/inter_instance_fetch.ts`
- Create: `apps/api/src/routes/v1/network/item/markers.ts`
- Modify: the network item route registration (where `fetch_item` is registered)
- Create: `apps/api/src/routes/v1/network/item/__tests__/markers.integration.test.ts`

**Interfaces:**
- Produces: `fetchMarkersAcrossInstances({ networkConfig, filters, requestedCacheTtlSeconds, log })` → `{ meta:{total,limit,offset,partial,unavailable_instances}, markers: MarkerRow[] }`. Reuses `buildPagePlan` + `getInstanceCount` (export it) — counts are projection-independent, so the count/plan logic is shared; only the page fetch is slim (`fetchLocalMarkers` locally / `POST /item/markers_local` peer). Uses a distinct `marker-page:*` cache key prefix. Never caches a partial aggregate.
- Produces routes: `GET /api/v1/network/item/markers` (aggregate, `MarkersQuerySchema`, response `{meta, markers}`), `POST /api/v1/network/item/markers_local` (peer, `peer_instance_guard`, `MarkersBodySchema`, response `{meta:{total,limit,offset}, markers}`).

- [ ] **Step 1: Export `getInstanceCount`; add `fetchMarkersAcrossInstances`**

In `inter_instance_fetch.ts`, `export` the existing `getInstanceCount` (additive; no behavior change). Add `fetchMarkersAcrossInstances` mirroring `fetchItemsAcrossInstances` (same allSettled count → `buildPagePlan` → allSettled slim page fetch → merge → `partial`/`unavailable_instances` → cache under `marker-page:*`), but calling a slim `fetchInstanceMarkers` (local `fetchLocalMarkers` / peer `POST /item/markers_local`). Keep the "never cache partial" rule.

> Do NOT refactor `fetchItemsAcrossInstances` itself (P5 reworks both to scatter-gather). Some duplication between the two aggregators is acceptable now; note it for P5 to unify.

- [ ] **Step 2: Add the markers routes**

Create `markers.ts` mirroring `fetch_item.ts`'s aggregate + peer handlers (served-domain guard, `getNetworkConfigById`, `lifecycle_filter: 'live_only'`, `x-network-partial` header, 500 on throw). Register the plugin alongside `fetch_item`.

- [ ] **Step 3: Integration test (docker db)**

Create `markers.integration.test.ts`: seed items with known coords in a dedicated partition, drive `GET /network/item/markers` via `app.inject`, assert: slim payload (only the 4 fields, no `item_state`), radius filter correctness, nearest-first ordering, `meta.total`/`limit`/`offset`, `meta.partial === false` single-instance. (Follow the existing `*.integration.test.ts` harness: skip when no `POSTGRES_URL`, seed + cleanup, register only the needed route plugins.)

- [ ] **Step 4: Verify + commit**

Run the markers integration test + `pnpm --filter api test` + `pnpm typecheck` → PASS.

```bash
git add apps/api/src/utils/inter_instance_fetch.ts apps/api/src/routes/v1/network/item/markers.ts apps/api/src/routes/v1/network/item/__tests__/markers.integration.test.ts <route-registration-file>
git commit -m "feat(api): GET /network/item/markers slim viewport endpoint (#203 §4.3)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: UI network-api markers fetch + `VITE_MAP_FETCH_LIMIT` + `itemDetail` key

**Files:**
- Modify: `apps/ui/src/lib/network-api.ts`
- Modify: `apps/ui/src/lib/query-keys.ts`

**Interfaces:**
- Produces: `fetchNetworkMarkers(query, signal): Promise<MarkersResponse>` where `MarkersResponse = { meta: { total, limit, offset, partial, unavailable_instances }, markers: Marker[] }`, `Marker = { item_id, item_domain, item_instance_url, item_locations }`. Query carries `item_network, item_domain, item_type?, item_latitude, item_longitude, radius_meters, item_state?, limit, offset?, cache_ttl_seconds?`.
- Produces: `resolveMapFetchLimit()` + `MAP_FETCH_LIMIT` (default 5000 from `VITE_MAP_FETCH_LIMIT`, mirror `resolveProfileFetchLimit`).
- Produces: `queryKeys.itemDetail(networkId: string, itemId: string) => ['item-detail', networkId, itemId] as const`.

- [ ] **Step 1: Add types + fetcher** (mirror `fetchNetworkItems` param serialization; new `/api/v1/network/item/markers` GET).
- [ ] **Step 2: Add `resolveMapFetchLimit`/`MAP_FETCH_LIMIT`.**
- [ ] **Step 3: Add `itemDetail` key + test in `query-keys.test.ts`.**
- [ ] **Step 4:** `pnpm typecheck` + `pnpm --filter ui test` → PASS; commit.

```bash
git commit -m "feat(ui): fetchNetworkMarkers + VITE_MAP_FETCH_LIMIT + itemDetail key (#203 §5.2/§5.4)"
```

---

### Task 4: `useMapMarkers` (viewport) + `useItemDetail` (per-id) hooks

**Files:**
- Create: `apps/ui/src/hooks/use-map-markers.ts` + test
- Create: `apps/ui/src/hooks/use-item-detail.ts` + test
- Modify/reuse: `apps/ui/src/lib/geo/distance.ts` (half-diagonal helper)

**Interfaces:**
- `useMapMarkers(network, domains, viewport, opts?)` where `viewport = { lat, lng, radiusMeters } | null`; returns `{ markers: Marker[]; total: number; partial: boolean; isLoading: boolean }`. Keyed `queryKeys.markers(networkId, domainId, { radiusBucket, lat, lng, limit, fields })` per visible domain (via `useQueries`), `staleTime` 90s, `cache_ttl_seconds` passed, `limit: MAP_FETCH_LIMIT`. Rounds lat/lng/radius into a bucket in the key so tiny pans reuse cache (spec §8 flag-back: rounded viewport bucket). Merges markers across domains. Disabled when `viewport` is null.
- `useItemDetail(networkId, item, opts?)` — lazily fetch one item's full detail by id (via `fetchNetworkItems` with `item_id`, routed by `item.item_instance_url`), keyed `queryKeys.itemDetail(networkId, itemId)`, `staleTime` 5 min, `enabled` only when requested (marker opened). Returns `{ item, isLoading }`.

- [ ] **Step 1:** viewport→radius half-diagonal helper (reuse `distance(a,b)` if present in `lib/geo/distance.ts`; else add `haversineMeters`).
- [ ] **Step 2:** `useMapMarkers` (+ test: fetches per domain with lat/lng/radius, merges, disabled when viewport null, rounds the key bucket so a sub-threshold pan doesn't refetch).
- [ ] **Step 3:** `useItemDetail` (+ test: fetches by id when enabled, cached, disabled otherwise).
- [ ] **Step 4:** `pnpm typecheck` + `pnpm --filter ui test` → PASS; commit.

---

### Task 5: `MapView` — optional `onViewportChange` (no contract break)

**Files:** Modify `apps/ui/src/components/map/map-container.tsx`.

**Interfaces:** Add OPTIONAL props: `onViewportChange?: (viewport: { lat: number; lng: number; radiusMeters: number }) => void`. On debounced `moveend`, compute `center = map.getCenter()` and `radiusMeters = distance(center, NE-corner-of-bounds)` (half-diagonal) and call `onViewportChange`. When the prop is absent (tourist app), behavior is unchanged.

- [ ] **Step 1:** Add the prop; wire a debounced `moveend`/idle handler in the active provider(s) or the container (whichever owns the map instance) to emit `{lat,lng,radiusMeters}`. Reuse the map bounds API (Leaflet `getBounds`/Google `getBounds`). Debounce ~300ms; guard against emitting before the map is ready.
- [ ] **Step 2:** Confirm the tourist path (no `onViewportChange`) is untouched — `pnpm --filter ui test`, and re-read `tourist/tourist-map.tsx` to confirm it doesn't pass the new prop.
- [ ] **Step 3:** `pnpm typecheck`; commit.

> If the map providers (`providers/leaflet-provider.tsx`, `providers/google-maps-provider.tsx`) each own their own map instance, the viewport callback must be wired in BOTH (or in a shared container hook). Trace which layer holds the map instance + bounds before editing; report NEEDS_CONTEXT if the provider abstraction makes a clean single-point wiring impossible.

---

### Task 6: Home-page map → viewport markers + lazy popup + federation indicator

**Files:** Modify `apps/ui/src/pages/home-page.tsx`.

**Interfaces:** Consumes `useMapMarkers`, `useItemDetail`, `MapView.onViewportChange`.

- [ ] **Step 1:** Add `mapViewport` state (`{lat,lng,radiusMeters}|null`); initialize center from `userLocation` else the existing default. Wire `<MapView onViewportChange={setMapViewport} .../>`.
- [ ] **Step 2:** `const mapMarkers = useMapMarkers(network, visibleDomains, mapViewport, { fields: activeMapFieldFilters })`. Feed `MapView items` from `mapMarkers.markers` mapped to the MapView item shape `{ id: item_id, domain: item_domain, data: { item_locations } }` (MapView reads `data.item_locations` for coords — no client geocoding needed).
- [ ] **Step 3:** Map enum filters server-side (design decision §D1): pass single-value-per-field selections from `mapSelectedFields` to `useMapMarkers` as an `item_state` filter; multi-value fields are not filtered server-side in P4 (documented). Keep `MapFiltersPanel` mounted.
- [ ] **Step 4:** Lazy popup: in `renderPopup`, use `useItemDetail(network.id, { item_id: baseItemId, item_instance_url: marker...})` (or a small popup child component that calls the hook) to fetch the full item on open; show a brief loading state, then the existing `MarkerPopupCard`. (A popup child component that calls `useItemDetail` is cleanest — hooks can't be called inside the `renderPopup` callback.)
- [ ] **Step 5:** Federation indicator (§6): when `mapMarkers.partial`, render a small "some sources unavailable" banner over the map (translated key `home.map_partial`), so a degraded marker set isn't presented as complete.
- [ ] **Step 6:** `pnpm typecheck` + `pnpm --filter ui test` → PASS. Commit.

> Do NOT remove `useBrowseItems`/`domainItems` yet (Task 7) — during this task the list still uses the paged hook (P3) and the map now uses markers; `domainItems` may still back the popup `fullItem` fallback and the header count until Task 7 re-sources them.

---

### Task 7: Remove the full `useBrowseItems` fetch from home-page

**Files:** Modify `apps/ui/src/pages/home-page.tsx` (+ delete `apps/ui/src/hooks/use-browse-items.ts` + test if no other consumer).

- [ ] **Step 1:** Confirm nothing but the map/popup/header still reads `domainItems`/`useBrowseItems` (grep). Re-source the ContentHeader "count" from the list totals (single-domain `singleDomainList.total`; All-tab `allDomainsTotalCount`) — resolves the P3-deferred header-count-vs-list-total mismatch. Re-source the All-tab loading gate from the paged hooks (resolves the P3-deferred loading-flash).
- [ ] **Step 2:** Delete the `useBrowseItems` call + `domainItems`/`filteredDomainItems` (map path now uses markers; popup uses `useItemDetail`). Delete `use-browse-items.ts` + its test if it has no other importer (`grep -r useBrowseItems`).
- [ ] **Step 3:** `pnpm typecheck` (remove now-unused imports) + `pnpm --filter ui test` → full suite green. Commit.

> This is the cleanup that completes the list/map decoupling the spec's §5.2 note calls for. If `domainItems` turns out to still back a non-map concern that markers/detail don't cover, STOP and report DONE_WITH_CONCERNS rather than deleting it.

---

## Self-Review

**Spec coverage:** §4.3 markers endpoint → Tasks 1 (schema + `fetchLocalMarkers`) + 2 (aggregate + routes + integration test). §4.5 limits → Task 1 (markers max 10000, full cap unchanged). §5.4 config → Task 3 (`VITE_MAP_FETCH_LIMIT` 5000). §5.2 map viewport fetch + decoupled marker set + lazy per-id detail (§10) → Tasks 4 (hooks) + 5 (MapView callback) + 6 (home-page wiring) + 7 (decouple). §6 federation indicator → Task 6 Step 5. §4.4 scatter-gather explicitly deferred to P5 (markers use the same count-block concatenation as item-fetch).

**Scope Check (writing-plans):** server (Tasks 1–2) and UI (3–7) are separable; kept as one P4 plan because §5.2 depends on the endpoint. Tasks 6–7 are the risky home-page map integration + cleanup; 7 can fold into 6 if review prefers, or stay split so the map-on-markers change is reviewable before the `useBrowseItems` deletion.

**Placeholder scan:** server tasks carry concrete code/shapes; UI tasks specify hook interfaces + integration points and reuse existing helpers (MapView contract, `MarkerPopupCard`, `distance`, enum-filter) rather than duplicating. The map-provider viewport wiring (Task 5) and the map-enum-filter approach (Task 6/§D1) carry explicit grounding steps + a flagged decision, not guesses.

**Type consistency:** `Marker`/`MarkerResponse` shape identical across schema (`MarkerResponseSchema`), runtime (`fetchLocalMarkers`), aggregate (`fetchMarkersAcrossInstances`), network-api (`fetchNetworkMarkers`), and `useMapMarkers`. `queryKeys.markers(...)`/`itemDetail(...)` used consistently. `MapView` new prop is optional (tourist unaffected).

**Behavior/risk notes:** MapView stays backward-compatible (tourist shares it — verified `tourist/tourist-map.tsx` imports it). Popups become lazy (a deliberate UX change per §5.2). Location-less items drop off the map (correct). The two Important design forks — map multi-value enum filtering (deferred) and the `useBrowseItems` removal ripple (header count / loading) — are called out in Design Decisions for the reviewer.

## Notes for P5
- Unify `fetchItemsAcrossInstances` + `fetchMarkersAcrossInstances` under the §4.4 scatter-gather top-K merge (recompute distance on the merging instance; preserve `meta.partial` through the merge). Both currently share count-block concatenation.
- Wire §8 instance-URL busting (markers/detail/browse/my-items keys + `clearSchemaCache`) when a `selectedApiUrl` switcher lands.
- §7 anon count-first: defer pins below ~zoom 8, show the count-first screen; the markers `meta.total` already supports the truthful "N in this area".
- Multi-value map enum filtering (deferred from P4 §D1).
