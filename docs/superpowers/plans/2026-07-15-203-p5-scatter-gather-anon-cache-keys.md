# #203 P5 — Cross-Instance Scatter-Gather + Federation/Anon UX + Cache-Key Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver P5 of #203: make cross-instance ordering correct (§4.4 scatter-gather top-K merge for fetch + markers), finish the federation-degradation UX (§6 list banner; map banner shipped in P4), add anonymous count-first browsing (§7), and lock cache-key correctness across the new axes (§8, incl. documenting the instance-URL-busting deferral).

**Architecture:** Server: today both aggregators concatenate per-instance count-blocks (`buildPagePlan`), which is only globally-ordered when a domain has ONE active instance. Add a shared scatter-gather core — for a domain with **>1 active instance**, ask each instance for its top `offset+limit` ordered rows, merge-sort the union on the merging instance (by recomputed nearest-location distance when geo is present, else `created_at DESC`), and slice `[offset, offset+limit)`. A domain with **one active instance keeps the current direct `[offset,limit)` path unchanged** (behavior + efficiency identical — the common case). Both `fetchItemsAcrossInstances` and `fetchMarkersAcrossInstances` use the shared core (the P4-noted unify), preserving `meta.partial`/`unavailable_instances`. UI: expose `partial` from the list hook + a list federation banner; a count-first screen for anonymous, no-location, zoomed-out users; and a cache-key audit.

**Tech Stack:** Fastify + Drizzle + Postgres server; React 19 + `@tanstack/react-query` v5 + Leaflet/Google map providers + Vitest.

**Epic context:** P5 of #203 (spec §4.4, §6 list, §7, §8), on branch `feat/ui-caching-strategy` (PR #295), on top of P3 (list paging) + P4 (markers/viewport map). **P6** (§9 relevance via signals-search) is cross-repo and follows separately.

**Out of scope (do NOT do here):** §9 relevance ranking (cross-repo); building an instance/API-URL switcher (none exists — §8 instance-URL busting stays documented-deferred); changing the single-instance fetch behavior (must stay byte-identical).

## Global Constraints

- **Branch:** `feat/ui-caching-strategy` (PR #295). Do NOT commit to `feature`/`develop`.
- **Server:** ESM, strict TS, no `any`. Routes never throw. Reuse existing helpers; the merge-sort distance recompute is a **pure JS haversine** on the merging instance over each row's `item_locations` (no schema change, no new SQL).
- **Single-instance behavior is frozen:** when a domain has ≤1 active instance, the fetch/markers path must be byte-identical to today (direct `[offset,limit)` fetch, same cache keys, same results). Scatter-gather applies **only** when >1 active instance.
- **Ordering key (matches §4.1/§4.4):** geo present (lat+lng) → ascending nearest-location distance (MIN over `item_locations`), no-location rows **last**, tie-break `created_at DESC`; no geo → `created_at DESC`. Markers are always geo (map viewport supplies a center), so markers merge by distance only.
- **`meta.partial`/`unavailable_instances`** preserved through the merge; **never cache a partial aggregate** (existing rule).
- **UI:** ESM, strict TS, no `any`, kebab-case, no `// TODO`. i18n keys added to en/hi/kn. Query keys only from `lib/query-keys.ts`.
- **§7 threshold:** defer pins below ~**zoom 8** (region level) for anonymous (`!user`) users with no resolved location. Reuse `VITE_MAP_DEFAULT_CENTER`/`VITE_MAP_DEFAULT_ZOOM`.

## Design decisions (FLAGGED for review)
1. **Scatter-gather only for >1 active instance.** Single-instance domains keep the exact current path. This bounds the risk of the rewrite to multi-instance deployments and keeps every current single-instance test/behavior unchanged. (The spec says "degenerates to the current single-instance path" — this makes that explicit and literal.)
2. **§8 instance-URL busting stays deferred** — there is still no `selectedApiUrl`/instance switcher in the UI (`setSelectedKey` has zero callers), so there is no event to bust on. P5 audits/locks the other axes (viewport bucket, offset, lat/lng — already keyed in P3/P4) and documents the instance-URL + `activeProfileId` (relevance, §9) axes as ready-to-wire follow-ups. A `bustInstanceScopedCaches` helper is provided, uncalled, only if review wants it; default is document-only.
3. **Multi-instance ordering is verified by unit-testing the pure merge core** (synthetic per-instance results) + single-instance integration (degeneration unchanged). A true 2-instance integration fixture is heavy; the manual smoke covers it if a peer network is available (noted).

## File Structure
- `apps/api/src/utils/geo_distance.ts` — **create**: pure `haversineMeters` + `nearestLocationMeters(center, item_locations)`.
- `apps/api/src/utils/instance_merge.ts` — **create**: pure `mergeSortAndSlice(rows, { center, offset, limit })` (distance-or-recency merge + slice).
- `apps/api/src/utils/inter_instance_fetch.ts` — **modify**: shared scatter-gather core used by both aggregators (>1 instance); single-instance path unchanged.
- `apps/api/src/utils/__tests__/instance_merge.test.ts` + `geo_distance.test.ts` — **create**.
- `apps/ui/src/hooks/use-infinite-browse-items.ts` — **modify**: expose `partial` (any loaded page partial).
- `apps/ui/src/pages/home-page.tsx` — **modify**: list federation banner (§6); anon count-first screen (§7).
- `apps/ui/src/components/map/map-container.tsx` + `providers/use-viewport-report.ts` — **modify**: include `zoom` in the `onViewportChange` payload (§7 threshold).
- `apps/ui/src/lib/query-keys.ts` + `AGENTS.md`/`CLAUDE.md` — **modify** (§8): audit + document deferred axes.
- i18n locale files — **modify**: `home.list_partial`, `home.map_count_first` (+ prompt).

---

### Task 1: Server pure helpers — haversine + merge-sort-slice

**Files:** create `apps/api/src/utils/geo_distance.ts`, `apps/api/src/utils/instance_merge.ts`, + tests.

**Interfaces:**
- `haversineMeters(a: {lat,lng}, b: {lat,lng}): number`.
- `nearestLocationMeters(center: {lat,lng}, locations: Array<{lat,lng}>): number` → MIN distance, or `Infinity` when no locations (sorts last).
- `mergeSortAndSlice<T extends { item_locations: Array<{lat:number;lng:number}>; created_at?: Date | string }>(rows: T[], opts: { center: {lat,lng} | null; offset: number; limit: number }): T[]` — when `center` set: stable-sort by `nearestLocationMeters` asc (Infinity last), tie-break `created_at` desc; else by `created_at` desc; then `slice(offset, offset+limit)`.

- [ ] **Step 1: TDD `geo_distance`** — write tests (known distances: 0 for identical; ~556m for 0.005° lat; nearest-of-multiple; Infinity for empty) → implement → green.
- [ ] **Step 2: TDD `instance_merge`** — tests: geo merge orders nearest-first across a shuffled union, no-location rows last, tie-break recency; non-geo merge orders `created_at` desc; slice respects offset/limit; stable for equal keys. → implement → green.
- [ ] **Step 3:** `pnpm --filter api test` + `pnpm typecheck` → PASS. Commit.

```
feat(api): pure haversine + cross-instance merge-sort-slice helpers (#203 §4.4)
```

---

### Task 2: Scatter-gather in `fetchItemsAcrossInstances` (>1 instance)

**Files:** modify `apps/api/src/utils/inter_instance_fetch.ts` + integration test.

**Interfaces:** unchanged public signature. Internally: after counting active instances, if `activeInstances.length <= 1` → the existing direct path (unchanged). If `> 1` → scatter-gather: fetch each active instance's `[0, offset+limit)` ordered rows (`fetchInstancePage` with `{offset:0, limit: offset+limit}`), `allSettled` (a failed peer → `partial`, excluded), `mergeSortAndSlice(union, { center: lat/lng, offset, limit })`. `meta.total` still = sum of per-instance counts. Preserve `partial`/`unavailable_instances`; never cache partial.

- [ ] **Step 1:** Extract a shared `scatterGatherPage({ activeInstances, filters, fetchPage })` helper (used by markers in Task 3) that returns the merged+sliced rows + the unavailable set. Center = `{lat: filters.item_latitude, lng: filters.item_longitude}` when both present, else null.
- [ ] **Step 2:** Branch `fetchItemsAcrossInstances`: `<=1` active → current path verbatim; `>1` → `scatterGatherPage`. Keep counts/total/cache/partial logic.
- [ ] **Step 3:** Integration test (docker db): single-instance path unchanged (existing behavior); add a unit-level test of the >1 branch by stubbing `fetchPage` to return two synthetic per-instance ordered lists and asserting the merged slice is globally nearest-first (the multi-instance HTTP path itself is exercised by the manual smoke with a peer network).
- [ ] **Step 4:** `pnpm --filter api test` + integration + `pnpm typecheck` → PASS. Commit.

```
feat(api): scatter-gather top-K cross-instance ordering for item fetch (#203 §4.4)
```

---

### Task 3: Scatter-gather in `fetchMarkersAcrossInstances`

**Files:** modify `apps/api/src/utils/inter_instance_fetch.ts` + markers integration test.

- [ ] **Step 1:** Apply the same `scatterGatherPage` helper (Task 2) to the markers aggregator (>1 instance → top-K merge by distance; markers always geo). `<=1` → current markers path unchanged.
- [ ] **Step 2:** Markers integration test: single-instance unchanged; a stubbed >1-instance merge test asserting nearest-first across instances (slim rows carry `item_locations`, so `nearestLocationMeters` works).
- [ ] **Step 3:** `pnpm --filter api test` + integration + `pnpm typecheck` → PASS. Commit.

```
feat(api): scatter-gather ordering for markers aggregate (#203 §4.4)
```

---

### Task 4: §6 list federation-degradation banner

**Files:** modify `apps/ui/src/hooks/use-infinite-browse-items.ts`, `apps/ui/src/pages/home-page.tsx`, i18n.

- [ ] **Step 1:** `useInfiniteBrowseItems` returns `partial: boolean` (true if any loaded page's `meta.partial`). (+ test.)
- [ ] **Step 2:** home-page list: when the active list feed is partial (single-domain `singleDomainList.partial`; All-tab any domain partial — thread `partial` through `DomainPagedFetch`/`allDomainPages`), render a translated banner ("some sources unavailable; results may be incomplete") above the list — reuse the P4 map-banner styling/pattern. Add `home.list_partial` to en/hi/kn.
- [ ] **Step 3:** `pnpm typecheck` + `pnpm --filter ui test` → PASS. Commit.

```
feat(ui): list federation-degradation banner on partial results (#203 §6)
```

---

### Task 5: §7 anonymous count-first browsing

**Files:** modify `apps/ui/src/components/map/map-container.tsx` + `providers/use-viewport-report.ts` (add `zoom` to the viewport payload), `apps/ui/src/pages/home-page.tsx`, i18n.

**Interfaces:** `onViewportChange` payload gains `zoom: number` → `{ lat, lng, radiusMeters, zoom }` (additive; tourist ignores it). `useMapMarkers` viewport param unchanged except it can read `zoom` for gating (or the home-page gates before enabling the hook).

- [ ] **Step 1:** Thread the map `zoom` into the viewport payload (both providers expose `map.getZoom()` at the `moveend`/`idle`/mount emit). Additive; keeps existing fields.
- [ ] **Step 2:** home-page: compute `countFirst = !user && !userLocation && (mapViewport?.zoom ?? DEFAULT_ZOOM) < REGION_ZOOM` (REGION_ZOOM ≈ 8). When `countFirst`, do NOT fetch/render pins (gate `useMapMarkers` disabled or pass a null viewport for the markers fetch); instead show a count-first overlay: the aggregate `meta.total` (from a lightweight count — reuse the markers/browse `meta.total`, or a `total` already available) + a prompt to "zoom in or share your location to see results." Once the user zooms past `REGION_ZOOM` or grants/sets a location, pins load normally.
- [ ] **Step 3:** Add `home.map_count_first` (e.g. "{{count}} results in this area — zoom in or share your location to see them") to en/hi/kn.
- [ ] **Step 4:** `pnpm typecheck` + `pnpm --filter ui test` → PASS. Commit.

```
feat(ui): anonymous count-first map browsing below region zoom (#203 §7)
```

> If obtaining an aggregate count without fetching pins is awkward (the markers endpoint returns `meta.total` alongside markers), the pragmatic path is: at count-first zoom, issue a `limit: 1` markers/count request purely for `meta.total` (cheap) and render the count without plotting pins. Document the choice.

---

### Task 6: §8 cache-key audit + deferral documentation

**Files:** modify `apps/ui/src/lib/query-keys.ts` (comments/helpers only), `AGENTS.md`, `CLAUDE.md`.

- [ ] **Step 1:** Audit that every result-changing axis is in the keys: rounded viewport/radius bucket (markers — P4 ✓), offset/page (`useInfiniteQuery` ✓), lat/lng (P3/P4 ✓). Add a doc comment on `browseItems`/`markers` enumerating the axes.
- [ ] **Step 2:** Document the two deferred axes in code + AGENTS/CLAUDE: (a) **instance/API base URL** — when a `selectedApiUrl` switcher is added, switching must bust browse/my-items/markers/`itemDetail` React Query caches + the schema cache (`clearSchemaCache`); no switcher exists today. (b) **active profile id** — only affects results once relevance (§9) ranks per profile; add to browse/markers keys then. Optionally add an uncalled `bustInstanceScopedCaches(queryClient)` helper if review wants it (default: document-only).
- [ ] **Step 3:** `pnpm typecheck` → PASS. Commit.

```
docs(ui): cache-key axis audit + instance-URL/profile deferral notes (#203 §8)
```

---

## Self-Review

**Spec coverage:** §4.4 → Tasks 1–3 (pure merge core + item + markers scatter-gather, >1-instance only, single-instance frozen). §6 list banner → Task 4 (map banner was P4). §7 anon count-first → Task 5. §8 → Task 6 (audit + documented deferrals; instance-URL has no switcher; activeProfileId waits for §9). §9 relevance is P6/cross-repo, out of scope.

**Scope Check:** server (Tasks 1–3) and UI (4–6) separable; kept as one P5 plan. §4.4 (Tasks 2–3) is the high-risk core but bounded to the >1-instance branch — single-instance behavior is frozen and covered by existing tests.

**Placeholder scan:** Task 1 carries concrete pure-function interfaces + test cases; server rewrites specify the exact branch condition and the shared helper; UI tasks specify the gating expression and the i18n keys. The count-first count-source and the multi-instance test approach carry explicit fallback notes.

**Type consistency:** `mergeSortAndSlice` generic works for both full items (have `created_at`) and slim markers (geo-only, distance merge); `scatterGatherPage` shared by both aggregators; `onViewportChange` payload extended additively with `zoom`; `useInfiniteBrowseItems` gains `partial`.

**Risk notes:** the scatter-gather branch only runs with >1 active instance (rare in most deployments, hard to integration-test locally) — mitigated by unit-testing the pure merge core exhaustively + freezing/covering the single-instance path + a peer-network manual smoke. `meta.partial` and never-cache-partial are preserved.

## Notes for P6 (§9 relevance, cross-repo)
- When relevance ranking lands, add `activeProfileId` to `browseItems`/`markers` keys (ranking basis differs per profile) and switch the merge key from distance to the relevance score where present.
- Wire instance-URL busting (§8) if/when a `selectedApiUrl` switcher is introduced.
