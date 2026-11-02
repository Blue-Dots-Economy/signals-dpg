# Map freeze with dense markers — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the map responsive on Google and Leaflet with ~10,000 markers in view by building markers only for what is on screen, and stop the map from going blank or rebuilding on every pan.

**Architecture:** Data side (`use-map-markers.ts`, `home-page.tsx`, `map-container.tsx`) fetches 25% beyond the screen, keeps the previous result during viewport refetches, and keeps the marker list's identity unless the data changed. A new provider-agnostic module clusters plain coordinates with `supercluster` and returns only the bubbles and pins inside the current view; each provider draws only that output. `MarkerClusterer` and `react-leaflet-cluster` are removed.

**Tech Stack:** React 19, TypeScript, TanStack Query 5, `@vis.gl/react-google-maps` 1.10, `react-leaflet`, `supercluster` 8.0.1, Vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-11-02-map-freeze-dense-markers-design.md` (issue #879, story #854). Read it first.

## Global Constraints

- Branch `perf/854-map-freeze`, cut from `origin/feature`. Never commit to `feature` or `develop`. Do not push.
- No API changes and no new API endpoints.
- `supercluster` `8.0.1` and `@types/supercluster` `7.1.3`, exact versions (already in the lockfile).
- Marker limit: `VITE_MAP_MARKER_CAP_INDIVIDUAL` default `10000` (was `500`); `VITE_MAP_MARKER_CAP_CLUSTERED` default stays `1000`.
- Fetch padding: 25% of the view's height/width added on each side.
- Clustering: merge points closer than 80 screen px — supercluster `radius: 160` with the default `extent: 512` (256-px tiles); clustering on at every zoom up to the provider's maximum (Google `22`, Leaflet `18`).
- At the provider's maximum zoom, a cluster of `50` or fewer points is returned as its individual points.
- Same-spot listings keep today's 10 m ring (`spreadCoLocatedMarkers`, unchanged).
- Tourist map (`tourist/tourist-map.tsx`), self marker, recenter, count pill, "Search this area", popups and the mobile bottom sheet keep today's behaviour.
- Code comments: none by default; at most a single one-line comment where the code cannot show a non-obvious reason. No history, issue numbers or multi-line blocks. Run `git diff | grep '^+ *//'` before every commit and delete anything that fails this rule.
- Tests on this 8 GB Mac: always `--pool=forks --maxWorkers=2`.
- Commit messages describe the concrete change; no AI attribution lines.

## Review Focus

- **A filter or search change while markers are shown** — pins from the old filter must disappear (no stale pins tappable); only pure viewport changes keep the previous markers. Test in Task 2.
- **A capped answer (server total above the limit)** — the count pill must not show the padded area's server total as the visible count; it shows a lower bound with the "zoom in" (`N+`) label. Test in Task 2.
- **Zoomed out past the antimeridian / world view** — the padded fetch bbox must still be clamped (`clampBbox`) and the cluster query must not throw on bounds wider than 360°. Tests in Tasks 2 and 4.
- **A single listing with several locations** — produces several points; bubble counts count points, the pill counts listings. Test in Task 4.
- **A cluster clicked at the provider's maximum zoom** — must not animate or loop; ≤ 50 points render as pins, larger stays a bubble. Tests in Tasks 4 and 5.

## Measurement tool

The scripted probe used for the baseline is `/private/tmp/claude-501/-Users-srivastha-KKB-Github/3fed8bd2-bdf1-4ec1-ab9a-4ad815ec172f/scratchpad/repro854b.mjs` (not committed). It loads `$URL` (default `http://localhost:5173/`), zooms out 4 wheel steps, pans once, and prints long frames, the longest unresponsive gap, and when markers disappeared and returned.

```bash
S=/private/tmp/claude-501/-Users-srivastha-KKB-Github/3fed8bd2-bdf1-4ec1-ab9a-4ad815ec172f/scratchpad
CH="$HOME/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"
# Google:  MAPSEL='.gm-style'           MK='gmp-advanced-marker'
# Leaflet: MAPSEL='.leaflet-container'  MK='.leaflet-marker-icon'
cd $S && CHROME="$CH" MAPSEL='.gm-style' MK='gmp-advanced-marker' TAG=google node repro854b.mjs $S
```

Switch providers by setting `VITE_MAP_PROVIDER` (`google-maps` | `leaflet`) in both root `.env` and `apps/ui/.env`, then restart Vite. Do not run the probe while someone else is using the stack. Record every run's numbers in `docs/superpowers/plans/2026-11-02-map-freeze-measurements.md` (Task 1 creates it).

---

### Task 1: Baseline measurements on `feature`

**Files:**
- Create: `docs/superpowers/plans/2026-11-02-map-freeze-measurements.md`

- [ ] **Step 1:** Confirm the stack is up (API `:2742`, UI `:5173`) and the seed is present: `docker exec dpg-db psql -U <user> -d <db> -tAc "select item_domain,count(*) from zz_perf854_seed group by 1"` → provider 10000, seeker 4000, service_provider 300.
- [ ] **Step 2:** Run the probe on the dev server for Google, then for Leaflet.
- [ ] **Step 3:** Build and serve production: `pnpm --filter ui build && pnpm --filter ui exec vite preview --port 4173`; run the probe with `URL=http://localhost:4173/` for both providers.
- [ ] **Step 4:** Write a table per run (provider × build × action: longest gap, frames over 200 ms, markers gone/back times) into the measurements file.
- [ ] **Step 5:** Commit: `git add docs/superpowers/plans/2026-11-02-map-freeze-measurements.md && git commit -m "docs(map): record baseline map freeze measurements on feature"`

### Task 2: Data side — padded fetch, keep markers on pan/zoom, visible-area count, cap default

**Files:**
- Modify: `apps/ui/src/lib/map-caps.ts` (default individual cap)
- Modify: `apps/ui/src/lib/map-viewport-snap.ts` (export a padding helper)
- Modify: `apps/ui/src/hooks/use-map-markers.ts`
- Test: `apps/ui/src/lib/map-caps.test.ts`, `apps/ui/src/lib/map-viewport-snap.test.ts`, `apps/ui/src/hooks/use-map-markers.test.tsx`, `apps/ui/src/lib/query-keys.test.ts`

**Interfaces:**
- Produces: `useMapMarkers(...)` keeps its signature and `UseMapMarkersResult` shape. Guarantees: `markers` keeps the same array reference across renders unless a query's data changed; `markers` is not emptied while a viewport-only refetch is loading.
- Produces: `expandBboxForFetch(bbox: RawBbox): RawBbox` in `map-viewport-snap.ts` — pads 25% per side then `clampBbox`.

- [ ] **Step 1: Write the failing tests**
  - `map-caps.test.ts`: `resolveIndividualMarkerCap()` with no env → `10000`.
  - `map-viewport-snap.test.ts`: `expandBboxForFetch({minLat:10,minLng:70,maxLat:20,maxLng:80})` → `{minLat:7.5,minLng:67.5,maxLat:22.5,maxLng:82.5}`; a world bbox `{minLat:-80,minLng:-179,maxLat:80,maxLng:179}` → clamped to valid lat/lng bounds.
  - `use-map-markers.test.tsx` (new cases):
    - `requests the viewport padded by 25% per side` — viewport bbox 10–20 / 70–80 → `fetchNetworkMarkers` called with `min_lat: 7.5, max_lat: 22.5, min_lng: 67.5, max_lng: 82.5`.
    - `does not refetch a pan that stays inside the fetched (padded) area` — second viewport shifted by 20% of the width → one call per domain total.
    - `refetches a pan that leaves the fetched area` — shifted by 30% → second call.
    - `keeps the previous markers while a viewport refetch is loading` — make the second response a never-resolving promise; after the pan, `result.current.markers` still equals the first response's ids.
    - `clears markers while a filter change is loading` — same setup, but change `filters` instead of the viewport → `markers` is `[]` while loading.
    - `keeps the markers array reference across a pan that reuses data` — `const first = result.current.markers;` rerender with a contained viewport → `toBe(first)`.
    - `counts only markers inside the visible area for a complete answer` — 3 markers, 2 inside the shown bbox → `total === 2`.
    - `for a capped answer, counts fetched markers in view and marks truncated` — `meta.total: 20000`, cap 1000 (zoom < 14), 5 fetched markers of which 3 in view → `total === 3`, `truncated === true`.
    - `does not refetch when zoom crosses 14 while both caps are equal` — default caps (10000 at both bands via test env) → one call per domain.
  - Update existing cases that assert the old behaviour: the band-crossing refetch tests (`refetches when zoom crosses the cluster-disable band…`, `…CURRENT (tighter) bbox…`) now set the individual cap to differ from the clustered cap via `capForZoom` options/env so a band crossing still refetches when the caps differ; `uses the individual zoom-band cap (+1)…` expects `10001`.
  - `query-keys.test.ts`: the markers key no longer includes `zoomBand`.
- [ ] **Step 2: Run to see them fail**
  Run: `pnpm --filter ui exec vitest run src/lib/map-caps.test.ts src/lib/map-viewport-snap.test.ts src/hooks/use-map-markers.test.tsx src/lib/query-keys.test.ts --pool=forks --maxWorkers=2`
  Expected: the new cases FAIL.
- [ ] **Step 3: Implement**
  - `map-caps.ts`: `DEFAULT_INDIVIDUAL_MARKER_CAP = 10000`.
  - `map-viewport-snap.ts`: add `expandBboxForFetch` (reuse `padBbox(bbox, 0.5)` then `clampBbox`).
  - `use-map-markers.ts`:
    - The fetch bbox is `expandBboxForFetch(rawBbox)`; held state stores that fetched bbox; reuse when the new `rawBbox` is contained in the held fetched bbox (`bboxContains`), the held answer was not truncated or empty, and the cap is unchanged. Replace `zoomBand` in `HeldBboxState` with `cap: number`, and drop `zoomBand` from the query key filters (`limit` already carries the cap).
    - Add `placeholderData: (prev, prevQuery) => …` returning `prev` only when the previous query's key differs from the new one in viewport fields alone (same `filters`, `q`, `satisfiable`, `limit`); otherwise `undefined`.
    - Split the memo: `markers` depends only on `dataSignature`; `total`/`truncated`/`partial` depend on data plus `shownBboxSignature`.
    - `total` per domain: markers inside the shown bbox (`markerInBbox`) — for both complete and capped answers; `truncated` stays `serverTotal > cap`.
- [ ] **Step 4: Run the tests** (same command) → PASS. Then `pnpm --filter ui exec tsc --noEmit` → no errors.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/ui/src/lib/map-caps.ts apps/ui/src/lib/map-caps.test.ts apps/ui/src/lib/map-viewport-snap.ts apps/ui/src/lib/map-viewport-snap.test.ts apps/ui/src/hooks/use-map-markers.ts apps/ui/src/hooks/use-map-markers.test.tsx apps/ui/src/lib/query-keys.test.ts
  git commit -m "fix(map): fetch 25% beyond the view, keep markers during pan/zoom refetch, raise street-zoom marker limit to 10000"
  ```

### Task 3: Build marker objects once per data change

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx` (`mapItems`, `MapView` props)
- Modify: `apps/ui/src/components/map/map-container.tsx` (`MapView`)
- Test: `apps/ui/src/components/map/__tests__/map_container_and_filters.test.tsx`

**Interfaces:**
- Consumes: Task 2's stable `markers` reference.
- Produces: `MapView` gains `loading?: boolean` (default `false`). The `markers` prop it passes to the provider keeps its reference while `items`, `schema`, `resolveMarkerLabel` and `selfLocation` are unchanged.

- [ ] **Step 1: Write the failing tests** in `map_container_and_filters.test.tsx`:
  - `passes the same markers array to the provider when re-rendered with the same items` — mock the active provider to capture `props.markers`; rerender with an unrelated prop change → captured arrays are `toBe` equal.
  - `shows the loading message only when loading and no markers are shown` — `loading` + empty items → "loading" text; `loading` + items → no overlay.
  - `fans same-coordinate items on the 10 m ring as before` — two items at one coordinate → two markers at different coordinates (existing helper behaviour preserved).
- [ ] **Step 2: Run to see them fail:** `pnpm --filter ui exec vitest run src/components/map/__tests__/map_container_and_filters.test.tsx --pool=forks --maxWorkers=2`
- [ ] **Step 3: Implement**
  - `map-container.tsx`: replace the async `resolveMarkers` effect and `markers`/`loading` state with a synchronous `React.useMemo` over `[items, schema, resolveMarkerLabel, selfLocation]` that builds the same `MapMarker`s and applies `spreadCoLocatedMarkers`. Overlay shows `t('map.loading')` when `loading && markers.length === 0`, else `emptyMessage` when `markers.length === 0`. Make the `onMarkerClick` wrapper a `useCallback` using a `Map` of id → marker built in the same memo.
  - `home-page.tsx`: wrap `resolveMarkerLabel` in `useCallback` if not already stable; pass `loading={mapMarkers.isLoading}` to `MapView`.
- [ ] **Step 4: Run the tests** → PASS; also `pnpm --filter ui exec vitest run src/pages/__tests__/home-page.test.tsx src/tourist --pool=forks --maxWorkers=2` → PASS; `pnpm --filter ui exec tsc --noEmit` → clean.
- [ ] **Step 5: Measure (dev server, both providers)** with the probe; append to the measurements file under "after Task 2–3". Expected: markers never drop to 0 during pan/zoom refetch.
- [ ] **Step 6: Commit**
  ```bash
  git add apps/ui/src/components/map/map-container.tsx apps/ui/src/components/map/__tests__/map_container_and_filters.test.tsx apps/ui/src/pages/home-page.tsx docs/superpowers/plans/2026-11-02-map-freeze-measurements.md
  git commit -m "fix(map): build map markers once per data change and show the loading overlay only before the first markers"
  ```

### Task 4: Shared clustering module

**Files:**
- Create: `apps/ui/src/components/map/map-clusters.ts`
- Create: `apps/ui/src/components/map/use-map-clusters.ts`
- Modify: `apps/ui/src/components/map/cluster-breakdown.ts` (add `breakdownFromCounts`)
- Modify: `apps/ui/package.json` (add `supercluster` `8.0.1`, `@types/supercluster` `7.1.3` as direct deps), `pnpm-lock.yaml`
- Test: `apps/ui/src/components/map/__tests__/map-clusters.test.ts`

**Interfaces:**
- Produces (in `map-clusters.ts`):
  ```ts
  export interface ClusterView { west: number; south: number; east: number; north: number; zoom: number }
  export type MapClusterItem =
    | { kind: 'cluster'; key: string; lat: number; lng: number; count: number; breakdown: DomainCount[]; expansionZoom: number }
    | { kind: 'point'; key: string; marker: MapMarker };
  export interface ClusterIndexOptions { maxZoom: number }
  export const CLUSTER_RADIUS = 64;
  export const MAX_ZOOM_EXPAND_LIMIT = 50;
  export function buildClusterIndex(markers: MapMarker[], options: ClusterIndexOptions): MapClusterIndex;
  export function queryClusters(index: MapClusterIndex, view: ClusterView): MapClusterItem[];
  ```
  `MapClusterIndex` is an opaque type wrapping the supercluster instance plus `maxZoom` and the id → marker map. Keys: `c:<cluster_id>` and `p:<marker.id>`.
- Produces (in `use-map-clusters.ts`): `useMapClusters(markers: MapMarker[], view: ClusterView | null, options: ClusterIndexOptions): MapClusterItem[]` — index rebuilt only when `markers` (by reference) or `maxZoom` change; returns `[]` while `view` is null.
- Produces (in `cluster-breakdown.ts`): `breakdownFromCounts(counts: Record<string, number>): DomainCount[]` — same ordering as `tallyDomains`.

- [ ] **Step 1: Write the failing tests** in `map-clusters.test.ts` (helper `pointsAtPixelOffset(zoom, dxPx)` builds two markers `dxPx` screen pixels apart at that zoom using Web Mercator, world size `256 * 2 ** zoom`):
  - `merges two points closer than one pin width` — 20 px apart at zoom 12 → one `cluster` with `count: 2`.
  - `keeps two points apart once they have room` — 50 px apart at zoom 12 → two `point`s.
  - `returns only items inside the view` — 3 markers, 1 outside the view → 2 items.
  - `counts per domain on each cluster` — 3 seeker + 2 provider at one spot, zoom 5 → `breakdown` `[{domain:'seeker',count:3},{domain:'provider',count:2}]`.
  - `gives the zoom a cluster click should go to` — two points 20 px apart at zoom 12 → `expansionZoom` > 12.
  - `expands a small cluster at the maximum zoom` — 3 markers on the 10 m ring, view zoom = `maxZoom` 18 → 3 `point`s.
  - `keeps a large same-spot group as one bubble at the maximum zoom` — 60 markers at one spot, zoom 18 → one `cluster` with `count: 60`.
  - `counts points, not listings` — markers `a#0`, `a#1` (same listing, two places far apart) → two points.
  - `handles a world-wide view` — view `west:-180,east:180,south:-85,north:85,zoom:1` with 1000 markers → no throw, counts sum to 1000.
  - `useMapClusters rebuilds the index only when the markers array changes` — `renderHook`, spy on `buildClusterIndex` via a module mock or count instances; new `view` with the same `markers` → no rebuild.
- [ ] **Step 2: Run to see them fail:** `pnpm --filter ui exec vitest run src/components/map/__tests__/map-clusters.test.ts --pool=forks --maxWorkers=2`
- [ ] **Step 3: Implement**
  - `pnpm --filter ui add supercluster@8.0.1 && pnpm --filter ui add -D @types/supercluster@7.1.3`.
  - `buildClusterIndex`: `new Supercluster({ radius: CLUSTER_RADIUS, maxZoom: options.maxZoom, map: p => ({ counts: { [p.domain]: 1 } }), reduce: (acc, p) => { merge p.counts into acc.counts } })`, loaded with one GeoJSON point per marker (`properties: { id, domain }`).
  - `queryClusters`: `getClusters([west, south, east, north], Math.floor(zoom))`, clamping `west/east` to `[-180, 180]`; map features to items; for a cluster at `Math.floor(zoom) >= maxZoom` with `point_count <= MAX_ZOOM_EXPAND_LIMIT`, replace it with `getLeaves(id, Infinity)` as points; `expansionZoom` from `getClusterExpansionZoom`.
- [ ] **Step 4: Run the tests** → PASS; `pnpm --filter ui exec tsc --noEmit` → clean.
- [ ] **Step 5: Commit**
  ```bash
  git add apps/ui/src/components/map/map-clusters.ts apps/ui/src/components/map/use-map-clusters.ts apps/ui/src/components/map/cluster-breakdown.ts apps/ui/src/components/map/__tests__/map-clusters.test.ts apps/ui/package.json pnpm-lock.yaml
  git commit -m "feat(map): add a shared clustering module that returns only the bubbles and pins in view"
  ```

### Task 5: Google provider draws only the clustering output

**Files:**
- Modify: `apps/ui/src/components/map/providers/google-maps-provider.tsx`
- Test: `apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx` (GoogleMapProvider block)

**Interfaces:**
- Consumes: `useMapClusters`, `MapClusterItem`, `ClusterView` (Task 4).
- Produces: no change to `MapProviderProps`.

- [ ] **Step 1: Write the failing tests** (replace the three `MarkerClusterer` tests: `registers every pin…`, `deregisters a pin…`, `tears the clusterer overlay down…`):
  - `draws one marker per visible bubble or pin, not one per listing` — 200 markers at one spot + 3 spread out; mocked map reports a view at zoom 10 → rendered `AdvancedMarker` count equals the `useMapClusters` output length (≤ 4), never 203.
  - `shows the count and per-domain chips on a bubble` — mixed-domain cluster → count text and one chip per domain.
  - `animates to the expansion zoom on bubble click` — click → `moveCamera` called, final call with `zoom` = item's `expansionZoom`.
  - `re-renders only the clicked pin when a popup opens` — wrap the point marker in a render counter; click one pin → other pins' counts unchanged.
  - `keeps the self marker outside clustering` — `selfLocation` set → self marker rendered and not counted in bubbles.
- [ ] **Step 2: Run to see them fail:** `pnpm --filter ui exec vitest run src/components/map/providers/__tests__/map-providers.test.tsx --pool=forks --maxWorkers=2`
- [ ] **Step 3: Implement**
  - Remove `MarkerClusterer`, `clusterRenderer`, `ClustererManager`, `markerDomainMap`, the `onMarkerReady` registration and `scheduleRender`.
  - Add `useGoogleClusterView(): ClusterView | null` in this file — reads `map.getBounds()`/`getZoom()` on mount and on every `idle`.
  - `GoogleMapProvider` renders, per item from `useMapClusters(markers, view, { maxZoom: 22 })`: a memoised `ClusterMarker` (`AdvancedMarker` whose React child reproduces `buildClusterContent`'s look; theme colour from one `resolveThemeColor` call memoised on `themeMode`) or a memoised `PointMarker` (today's `ClusteredMarker` body minus registration; `position` memoised on `lat`/`lng`).
  - `onMarkerActivate`/`onMarkerDeactivate` become `useCallback`s; `PointMarker` gets `isActive` as a boolean so only the affected pin re-renders.
  - Bubble click calls the existing `animateMapCamera` with the item's `lat`/`lng`/`expansionZoom`, capped at `CLUSTER_CLICK_MAX_ZOOM`.
- [ ] **Step 4: Run the tests** → PASS; `pnpm --filter ui exec tsc --noEmit` → clean.
- [ ] **Step 5: Measure (dev server, Google)** with the probe; append results.
- [ ] **Step 6: Commit**
  ```bash
  git add apps/ui/src/components/map/providers/google-maps-provider.tsx apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx docs/superpowers/plans/2026-11-02-map-freeze-measurements.md
  git commit -m "fix(map): Google map draws only visible bubbles and pins instead of one marker per listing"
  ```

### Task 6: Leaflet provider draws only the clustering output

**Files:**
- Modify: `apps/ui/src/components/map/providers/leaflet-provider.tsx`
- Test: `apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx` (LeafletMapProvider block)

**Interfaces:**
- Consumes: `useMapClusters`, `MapClusterItem`, `ClusterView`, `breakdownFromCounts` (Task 4).
- Produces: `createClusterDivIcon(count: number, breakdown: DomainCount[]): L.DivIcon` (replaces the child-marker signature).

- [ ] **Step 1: Write the failing tests** (replace `configures the cluster group…` and adapt `renders one clustered marker per item…`, `sizes the cluster bubble…`, `adds a per-domain badge row…`, `never fabricates an empty-domain group…` to the new signature):
  - `draws one marker per visible bubble or pin, not one per listing` — same shape as Task 5's test, view at zoom 10 → `<Marker>` count equals the cluster output length.
  - `zooms to the expansion zoom on bubble click` — click → `map.setView` (or `flyTo`) with the item's `expansionZoom`.
  - `uses the 18 maximum zoom so small groups open at max zoom` — 3 markers on the 10 m ring at zoom 18 → 3 point markers.
  - `reuses one icon per domain/icon/image combination` — two pins of the same domain → `L.divIcon` called once for them.
  - Keep: self marker outside clustering, popup width, `closePopupNonce`, viewport reporting and `FitBounds` tests unchanged.
- [ ] **Step 2: Run to see them fail** (same command as Task 5).
- [ ] **Step 3: Implement**
  - Remove `MarkerClusterGroup`, its CSS imports and `markerDomainMap`.
  - Add `useLeafletClusterView(): ClusterView | null` — `useMapEvents({ moveend, zoomend })` plus an initial read.
  - Render per item from `useMapClusters(markers, view, { maxZoom: 18 })`: a memoised cluster `<Marker icon={createClusterDivIcon(count, breakdown)}>` with a click handler to the expansion zoom, or a memoised point `<Marker>` with today's popup and click wiring; cache `createMarkerDivIcon` results in a module-level `Map` keyed by domain/icon/image/precision.
- [ ] **Step 4: Run the tests** → PASS; `pnpm --filter ui exec tsc --noEmit` → clean.
- [ ] **Step 5: Measure (dev server, Leaflet)**; append results.
- [ ] **Step 6: Commit**
  ```bash
  git add apps/ui/src/components/map/providers/leaflet-provider.tsx apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx docs/superpowers/plans/2026-11-02-map-freeze-measurements.md
  git commit -m "fix(map): Leaflet map draws only visible bubbles and pins instead of one marker per listing"
  ```

### Task 7: Remove the old clustering libraries

**Files:**
- Modify: `apps/ui/package.json`, `pnpm-lock.yaml`
- Modify: `apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx` (drop the `@googlemaps/markerclusterer` and `react-leaflet-cluster` mocks)

- [ ] **Step 1:** `git grep -n "@googlemaps/markerclusterer\|react-leaflet-cluster" -- apps/ui` → only `package.json` and the test mocks remain.
- [ ] **Step 2:** `pnpm --filter ui remove @googlemaps/markerclusterer react-leaflet-cluster`; delete the two `vi.mock` blocks.
- [ ] **Step 3:** `pnpm --filter ui exec vitest run --pool=forks --maxWorkers=2` → all UI tests PASS; `pnpm --filter ui exec tsc --noEmit` → clean; `pnpm --filter ui build` → succeeds.
- [ ] **Step 4: Commit**
  ```bash
  git add apps/ui/package.json pnpm-lock.yaml apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx
  git commit -m "chore(ui): remove MarkerClusterer and react-leaflet-cluster, now unused"
  ```

### Task 8: React Query comparison on large marker answers (decide by measurement)

**Files:**
- Modify (only if needed): `apps/ui/src/hooks/use-map-markers.ts`
- Test (only if needed): `apps/ui/src/hooks/use-map-markers.test.tsx`

- [ ] **Step 1:** Run the probe on the dev server for both providers. If any long frame's top script is `@tanstack_react-query` and exceeds 200 ms, continue; otherwise record "not needed" in the measurements file, commit it, and stop this task.
- [ ] **Step 2: Failing test:** `does not structurally share marker answers` — two identical responses for different keys → `result.current.markers[0]` is a different object after the second fetch.
- [ ] **Step 3:** Set `structuralSharing: false` on the marker queries.
- [ ] **Step 4:** Tests PASS; re-run the probe; record before/after.
- [ ] **Step 5: Commit:** `git commit -m "fix(map): skip React Query's field-by-field comparison for map marker answers"`

### Task 9: Final verification

**Files:**
- Modify: `docs/superpowers/plans/2026-11-02-map-freeze-measurements.md`

- [ ] **Step 1:** Production build + preview (`pnpm --filter ui build && pnpm --filter ui exec vite preview --port 4173`); run the probe for both providers. Targets: no frame over 200 ms during zoom-out or pan after the response arrives; markers never drop to 0 during a refetch.
- [ ] **Step 2:** Popup timing: in the probe page, click a single pin and time until the popup/sheet element appears → under 100 ms on both providers.
- [ ] **Step 3: Correctness checks in the browser, both providers:**
  - sum of bubble counts + pins in view = points in view (compare with the count of fetched markers inside the bounds via `window` debug in the console or a one-off script);
  - no two pins overlap except on the 2,500 / 800 same-spot points;
  - small pan reveals edge markers without a network request (DevTools network panel or probe log);
  - at street zoom over the seeded Ghaziabad point, the request uses `limit=10001`;
  - tourist map (`pnpm dev:tourist`), self marker, recenter, count pill (`N+` when capped), "Search this area", desktop popup and mobile bottom sheet (390×844) behave as before.
- [ ] **Step 4:** Full UI tests `pnpm --filter ui exec vitest run --pool=forks --maxWorkers=2` and `pnpm typecheck` → green.
- [ ] **Step 5:** Record the final before/after table and the deferred same-spot observation (how the 2,500-listing point looks and performs at max zoom) in the measurements file.
- [ ] **Step 6: Commit:** `git commit -m "docs(map): record final map freeze measurements and the same-spot observation"`
