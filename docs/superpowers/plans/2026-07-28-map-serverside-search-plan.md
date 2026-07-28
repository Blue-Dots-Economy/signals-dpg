# Map PR — server-side bbox search/filter + indexing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make the map fetch a bbox-scoped, server-side-filtered, zoom-capped marker set (native only), backed by a spatial index — replacing the radius + client-in-memory-filter + 25000-cap model. Covers the follow-up design's **P-follow-1 (indexing)** + **P-follow-2 (map bbox)**.

**Architecture:** UI sends `map.getBounds()` as a bbox; the API filters within the bbox server-side using **Option B** (join the existing `item_search.geo` GiST index) plus `item_state.*` facet params, and returns nearest-N (up to a zoom-band cap) + `meta.total`. The UI refetches only when the viewport escapes a padded bbox **or the last result was truncated**, re-clustering otherwise; over-dense viewports show "N+ in this area — zoom in."

**Tech Stack:** Fastify + Zod + Drizzle + Postgres (PostGIS on `item_search.geo`, cube/earthdistance on `items`); React 19 + React Query + vaul/leaflet/google maps.

## Global Constraints (confirmed decisions)

- **Geo index = Option B** — reuse `item_search.geo` (GiST) via SQL join to `items`. ⚠️ Couples map freshness to the search **ingestion pipeline**; **flag this in the PR description** (issue #1). Do NOT build the Option-A location table.
- **Map is native-only** — never call the signals-search *service*; only read the `item_search` *table* + `items`. Stays public / no-auth / edge-cacheable.
- **Truncated-refetch rule (confirmed):** refetch when the new bbox escapes the padded region **OR the last result was truncated** (`meta.total > cap`). Skip-fetch/re-cluster only when the last result was *complete* and the new bounds are contained.
- **Zoom-band caps:** 1000 (clustered, below cluster-disable zoom ~z14) / 500 (individual, z≥14). Fetch `cap + 1`. Env-overridable; cluster-disable-zoom is the breakpoint.
- **Cache key** must include snapped bbox + zoom band **and the active filter set**.
- Keep the radius params working (the list's distance path + tourist app still use radius).
- Files snake_case; routes never throw (return `reply.code().send({error,message})`); ESM, strict TS, no `any`; no `// TODO`. Migrations: read `apps/api/drizzle/README.md`; `items` is partitioned by `item_network` (partition-aware). Env vars go in BOTH `packages/config/src/secrets.ts` and `turbo.json` (`.claude/rules/env-vars.md`).
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `feat/map-serverside-search` (off `feature`). PRs draft. Rebase onto `feature` after mobile PR #375 merges (reconcile `map-filters-panel.tsx`).
- Run `pnpm --filter api test`, `pnpm --filter ui test`, `pnpm typecheck` green before each commit. Integration tests need `docker compose up -d db redis`.

---

## File Structure

**API**
- `packages/schemas/src/api/item_schemas.ts` — add bbox params (`min_lat/min_lng/max_lat/max_lng`) to `MarkersQuerySchema`/`MarkersBodySchema` + `FetchItemsQuerySchema`; keep radius; refine so bbox XOR radius.
- `apps/api/src/utils/item_fetch_runtime.ts` — `fetchLocalMarkers`: bbox WHERE via `item_search.geo` join (Option B) + `item_state` facet filters; `meta.total`.
- `apps/api/src/utils/inter_instance_fetch.ts` — thread bbox + `item_state` through `fetchMarkersAcrossInstances`/peer body.
- `apps/api/src/routes/v1/network/item/markers.ts` — pass the new params through (mostly passthrough).
- `packages/database/` — Drizzle **custom** migration: facet GIN/expression indexes on `items.item_state` (declared facets). `item_search_geo_gist` already exists (Option B) — no geo migration.
- `packages/config/src/secrets.ts` + `turbo.json` — map cap envs.
- `examples/schemas/**/network.json` — `filterable` facet markers (source of truth for which fields get indexed).

**UI**
- `apps/ui/src/engine/types.ts` — `MapViewport` gains bbox (`{ minLat,minLng,maxLat,maxLng, zoom }`).
- `apps/ui/src/components/map/providers/use-viewport-report.ts` — emit bbox + zoom (from `map.getBounds()`), not just center+radius.
- `apps/ui/src/hooks/use-map-markers.ts` — padded-bbox + truncated refetch state machine; zoom-band cap selection.
- `apps/ui/src/lib/query-keys.ts` — `markers` key: snapped bbox + zoom band + filters.
- `apps/ui/src/lib/network-api.ts` — send bbox + `item_state` params; replace single `MAP_FETCH_LIMIT` with zoom-band caps.
- `apps/ui/src/components/map/map-container.tsx` — over-dense "N+ zoom in" from `meta.total > cap`; cap wiring.
- `apps/ui/src/pages/home-page.tsx` — map filters panel drives `item_state` markers params (retire the map's in-memory filtering only).

---

## Task 1 — Facet indexes (P-follow-1) + `filterable` markers

**Files:** `examples/schemas/<net>/network.json` (add `filterable` markers to a couple of facet fields for tests), `packages/database/` custom migration, `apps/api/db/postgres/schema/*` + `schema.sql` regen.

**Interfaces:** Produces: GIN/expression indexes the bbox+facet query (Task 3) relies on.

- [ ] **Step 1: Confirm the facet source of truth.** Read how `network.json` field-role markers are parsed (`packages/config` / `@dpg/schemas`); pick the marker name (`filterable: true`) and the fields to index for the test network (e.g. `blue_dot` seeker: `gender`, `work_experience`, `nature_of_job`). Do NOT blanket-index all of `item_state`.
- [ ] **Step 2: Write a failing integration test** (`apps/api/src/.../__tests__/facet_index.integration.test.ts`): insert N items, `EXPLAIN` a filter on a declared facet path (`item_state->>'gender'`), assert an index scan (not seq scan). Run: expect FAIL (no index).
- [ ] **Step 3: Add the migration** — `drizzle-kit generate --custom` (partition-aware; `items` partitioned by `item_network`). GIN `jsonb_path_ops` on `items.item_state`, or expression btree per declared facet path. Follow `apps/api/drizzle/README.md`.
- [ ] **Step 4:** `pnpm db:generate:api` / apply; `pnpm schema:bundle` to refresh `schema.sql`. Re-run the EXPLAIN test → PASS.
- [ ] **Step 5: Commit** `feat(db): facet indexes on item_state for server-side map/list filtering (#203)`.

---

## Task 2 — bbox request params (schema + passthrough)

**Files:** `packages/schemas/src/api/item_schemas.ts`, `apps/api/src/routes/v1/network/item/markers.ts`, `apps/api/src/utils/inter_instance_fetch.ts`.

**Interfaces:** Produces: `min_lat/min_lng/max_lat/max_lng` on the markers query/body + `ItemFetchFilters`.

- [ ] **Step 1: Failing schema test** — assert `MarkersQuerySchema` accepts a bbox and rejects bbox+radius together (`.refine`).
- [ ] **Step 2: Add bbox to schemas** — `min_lat`,`min_lng`,`max_lat`,`max_lng` as `z.coerce.number().optional()` on `MarkersQuerySchema`, `MarkersBodySchema`, `FetchItemsQuerySchema`; refine: exactly one of {bbox, radius, none}. Keep radius fields.
- [ ] **Step 3: Thread through** — add the 4 fields to `ItemFetchFilters` and pass them in `markers.ts` (query→`fetchMarkersAcrossInstances` filters) and through `inter_instance_fetch.ts` into the peer `markers_local` body (mirror `radius_meters`).
- [ ] **Step 4:** schema test PASS; `pnpm --filter api exec tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(api): accept bbox on the markers endpoint (#203)`.

---

## Task 3 — `fetchLocalMarkers`: bbox filter (Option B) + facet filters + `meta.total`

**Files:** `apps/api/src/utils/item_fetch_runtime.ts`.

Read the current `fetchLocalMarkers` + the shared WHERE/ORDER-BY helpers (the `earth_box`/`ll_to_earth` radius block ~L86-97 and nearest-distance ~L127-138) before editing.

- [ ] **Step 1: Failing integration test** (`item_fetch_runtime.integration.test.ts`): seed items (incl. a multi-location item with one location in the box, one out); query with a bbox → assert only in-box items (any-location-in-box) return; assert `meta.total` = full in-box count even when `limit` truncates; assert an `item_state` facet filter narrows correctly.
- [ ] **Step 2: bbox WHERE via Option B.** When bbox params are present, filter by joining the GiST-indexed `item_search.geo`:
  ```sql
  EXISTS (
    SELECT 1 FROM item_search s
    WHERE s.item_network = items.item_network AND s.item_id = items.item_id
      AND s.lifecycle_status = 'live'
      AND s.geo && ST_MakeEnvelope(${minLng}, ${minLat}, ${maxLng}, ${maxLat}, 4326)::geography
  )
  ```
  (`&&` uses `item_search_geo_gist`; `geography` MultiPoint covers all locations → multi-location correct.) Keep the existing `earth_box` radius branch for the radius path. Select slim marker fields from `items` as today.
- [ ] **Step 3: Facet filters.** For each `item_state.<field>` filter param, add `items.item_state->>'field' = ANY(${values})` (uses Task 1's index). Keep it to declared facets.
- [ ] **Step 4: `meta.total`.** Return the total in-box (+facet) count via a `COUNT(*)` with the same WHERE (no limit), alongside the capped rows. Confirm the markers response `meta.total` reflects it.
- [ ] **Step 5:** integration test PASS (`docker compose up -d db redis; pnpm --filter api test:integration`); `EXPLAIN` shows GiST on `item_search.geo`.
- [ ] **Step 6: Commit** `feat(api): bbox + facet server-side filtering for markers via item_search.geo (Option B) (#203)`.

---

## Task 4 — UI viewport → bbox + query key

**Files:** `apps/ui/src/engine/types.ts`, `components/map/providers/use-viewport-report.ts` (+ both providers if they compute the payload), `lib/network-api.ts`, `lib/query-keys.ts`.

- [ ] **Step 1: Failing test** — `queryKeys.markers` includes snapped bbox + zoom band + filters (distinct keys for distinct bbox/zoom/filters; same for contained/same).
- [ ] **Step 2: `MapViewport`** — add `{ minLat, minLng, maxLat, maxLng, zoom }` (keep center/radius during transition or replace; radius still used by list).
- [ ] **Step 3: viewport-report** — emit `map.getBounds()` corners + `zoom` on debounced `moveend`/`zoomend` (+ once on mount), replacing/augmenting the half-diagonal radius for the map path.
- [ ] **Step 4: network-api** — markers fetch sends `min_lat/min_lng/max_lat/max_lng` + `item_state.*`; drop the single 25000 `MAP_FETCH_LIMIT`, send `limit = cap(zoomBand) + 1` (Task 6 provides the cap).
- [ ] **Step 5: query-keys** — `markers(networkId, domain, { snappedBbox, zoomBand, filters })`.
- [ ] **Step 6:** tests PASS; `pnpm --filter ui exec tsc -b`.
- [ ] **Step 7: Commit** `feat(ui): send map bbox + zoom-aware markers query key (#203)`.

---

## Task 5 — Refetch state machine (padded-bbox + truncated rule)

**Files:** `apps/ui/src/hooks/use-map-markers.ts`.

- [ ] **Step 1: Failing unit tests** (the behaviors you must guarantee):
  - zoom-in within padded bbox, last result **complete** → **no refetch** (re-cluster held set).
  - zoom-in within padded bbox, last result **truncated** (`meta.total > cap`) → **refetch** (the HSR-layout case).
  - pan-out beyond padded bbox → refetch.
- [ ] **Step 2: Implement** — keep last-fetched **padded bbox** (~25% inflate, snapped to a zoom-grid cell) + last `truncated` flag. On viewport change: `needFetch = !containedInPadded(newBbox) || lastTruncated`. When not fetching, re-run clustering on the held set. Update padded bbox + truncated on each fetch response.
- [ ] **Step 3:** tests PASS; `pnpm --filter ui exec tsc -b`.
- [ ] **Step 4: Commit** `feat(ui): contained-bbox + truncated-result refetch rule for the map (#203)`.

---

## Task 6 — Zoom-band caps + over-dense indicator

**Files:** `apps/ui/src/components/map/map-container.tsx`, `apps/ui/src/pages/home-page.tsx`, `apps/ui/src/lib/network-api.ts`.

- [ ] **Step 1: Failing tests** — cap = 1000 below cluster-disable-zoom, 500 at/above; when `meta.total > cap`, the over-dense indicator ("N+ in this area — zoom in") renders with the true total.
- [ ] **Step 2: Implement** — derive the active cap from the current zoom vs cluster-disable-zoom; fetch `cap+1`; when `meta.total > cap` show the over-dense pill (reuse the existing count-pill/`home.map_count_first`-style copy; add i18n key if needed in en/hi/kn). Mobile: allow a lower individual cap via env (mobile spec F1).
- [ ] **Step 3:** tests PASS.
- [ ] **Step 4: Commit** `feat(ui): zoom-band pin caps + over-dense zoom-in indicator (#203)`.

---

## Task 7 — Map filters panel drives server params + config/env

**Files:** `apps/ui/src/pages/home-page.tsx`, `apps/ui/src/components/map/map-filters-panel.tsx` (data wiring only — presentation is the mobile PR's), `packages/config/src/secrets.ts`, `turbo.json`.

- [ ] **Step 1: Failing test** — changing a facet filter or the search text updates the markers request params (server-side), not an in-memory filter, for the map path.
- [ ] **Step 2: Implement** — the filters panel's `selectedFields`/search feed the markers query's `item_state.*` params + text; **retire only the map's** `filteredDomainItems`-style in-memory filtering (the list stays as-is until the List PR). Text on the map = native `item_state` match (document the map-vs-list semantic difference, issue #5).
- [ ] **Step 3: Config** — add `MAP_MARKER_CAP_CLUSTERED`, `MAP_MARKER_CAP_INDIVIDUAL`, `MAP_CLUSTER_DISABLE_ZOOM` (env-overridable; UI reads via `getRuntimeEnv`/`import.meta.env`) to `secrets.ts` + `turbo.json`. Replace the single `VITE_MAP_FETCH_LIMIT` usage; keep it as a deprecated alias if simplest, else remove + update `.env.example`.
- [ ] **Step 4:** `pnpm --filter ui test` + `pnpm typecheck` green.
- [ ] **Step 5: Commit** `feat(ui): map filters drive server-side markers params; zoom-cap config (#203)`.

---

## Final verification (before the draft PR)
- [ ] `pnpm typecheck`; `pnpm --filter api test`; `pnpm --filter api test:integration` (docker db+redis); `pnpm --filter ui test` — all green.
- [ ] DevTools: bbox fetch on pan-out; zoom-in-within = no refetch (complete) vs refetch (truncated); caps + "N+ zoom in"; server-side filter narrows pins; multi-location item shows if any location in box.
- [ ] Open draft PR → `feature` with **In Plain Terms**, and **flag issue #1** (Option B couples the map to search-ingestion freshness) and note the list-fallback caveat (issue #2, handled in the List PR).

## Out of scope (this PR)
Relevance-ranked pins (P-follow-5), the `/discover` list path (List PR), Option A location table, cluster **aggregation** / vector tiles, location runtime-config (P-follow-4 — optional fold-in).
