# Map freeze with dense markers — design

Issue: #879 (sub-issue of story #854). Branch: `perf/854-map-freeze`, cut from `feature`.

## Why

With about 10,000 listings in view, the map page stops responding after a zoom-out or a pan, and every marker disappears while new data loads. It happens on both map providers (Google and Leaflet), on dev, on the seeker site and in production. The marker cap was raised to 10,000 on purpose so every listing is available on the map, so the fix must keep every listing reachable — it may not hide or drop listings to get speed.

## What we measured

Same scripted test each time: 1440×900 window, load the home map (zoom 11), zoom out 4 steps with the mouse wheel, then one drag-pan. Long frames come from the browser's Long Animation Frame API; "unresponsive" is the longest gap a 50 ms timer saw.

| Where | Build | Provider | Zoom-out | Pan |
|---|---|---|---|---|
| Seeker site (2026-10-30) | production | Google | frames of 7.2 s and 7.4 s, 14.6 s unresponsive | — |
| Local, 14,300 listings | development | Google | 44.8 s unresponsive; markers gone at ~52 s, back at ~62 s | 8.3 s; 0 markers 12 s later |
| Local, 14,300 listings | development | Leaflet | one 13.9 s frame; markers gone ~22 s, back ~29 s | frames of 7.7 s, 6.1 s, 4.1 s; 0 markers at the end |

The server is not the bottleneck: the 10,001-marker response takes about 1 s. The time is spent on the browser's main thread.

Local data: 10,000 job postings (2,500 on one Ghaziabad point), 4,000 seekers (800 on one Noida point), 300 service providers, tracked in the local-only table `zz_perf854_seed`. Local `.env` mirrors dev: `VITE_MAP_MARKER_CAP_CLUSTERED=10000`.

## Root causes (in the code on `feature`)

1. **One React component and one map marker per listing.** `ClustererManager` renders `markers.map(m => <ClusteredMarker/>)` (`google-maps-provider.tsx`), and each one creates a Google `AdvancedMarkerElement` with its own icon. Leaflet does the same with one `<Marker>` per listing inside `MarkerClusterGroup` (`leaflet-provider.tsx`), building a `divIcon` for each. 10,001 listings → 10,001 components and map markers, although only ~30 bubbles end up on screen.
2. **Google: every marker is placed on the map before clustering removes it.** vis.gl's `useAdvancedMarker` sets `newMarker.map = map` on creation; only afterwards does `MarkerClusterer` take ~9,970 of them off again.
3. **Every refetch tears all markers down and builds them again.** The marker queries in `use-map-markers.ts` have no "keep previous data", so when the query key changes the list is empty until the new response lands — React unmounts every marker (the blank map), then mounts all of them again.
4. **A pan with no new data still rebuilds everything.** The merged list in `use-map-markers.ts` is recomputed when the visible-area signature changes, `mapItems` (`home-page.tsx`) and `resolveMarkers` (`map-container.tsx`) then create new objects for every marker, and no marker component is memoised. The Google marker also gets a new `position` object each render, so vis.gl re-applies it to every marker element. A marker click re-renders all markers too (inline callbacks in `GoogleMapProvider`).
5. **React Query compares each large response field by field.** In the Leaflet run, frames of 3.6–7.7 s were React Query's own work (its structural sharing of the 1.8 MB response), not React rendering. To be confirmed by measurement.

## Goals

- Zoom, pan and click on the map stay responsive at any zoom, on Google and Leaflet, with production-scale data (~19,000 listings, ~2,500 sharing one point).
- Markers already on screen stay visible while new data loads.
- Every listing in view is counted in a cluster and is reachable by zooming in, except listings sharing one exact coordinate, which stay as today until the deferred decision below.
- The street-zoom marker limit no longer cuts listings off: the code default for zoom 14 and above rises from 500 to 10,000, the same as the clustered limit.
- The cost of drawing the map depends on what is on screen, not on how many listings were fetched.

## Non-goals

- Server responses, compression and caching (#880), duplicate requests at load (#881), the stale marker cache (#845).
- Server-side clustering or state → district → pin bubbles (kept as a last resort, only if this design is not enough).
- Lowering the marker cap.
- How listings that share one exact coordinate are shown (see "Deferred: same-spot listings").
- The cluster-icon overlap and map-height layout items listed in #854's description.

## Anti-goals (a failure even if it gets faster)

- Any listing in view that cannot be reached on the map.
- Cluster counts that do not add up to the listings in view.
- Popups, the mobile bottom sheet, the "You are here" marker, the recenter button, the count pill or the "Search this area" button behaving differently from today.
- The tourist map (`tourist/tourist-map.tsx`, orange_dot) breaking — it uses the same `MapView`.
- A new API endpoint or any API change.

## Design

### 1. Keep markers while loading; build the marker list only when the data changes

- `use-map-markers.ts`: the marker queries keep the previous result while the next one loads (React Query `placeholderData: keepPreviousData`), so the list never drops to empty during a refetch.
- `use-map-markers.ts`: the merged marker list depends only on the fetched data. The visible-area count (`total`) is computed separately, so a pan changes the count, not the list.
- `home-page.tsx` (`mapItems`) and `map-container.tsx` (`resolveMarkers`) create marker objects once per data change; an unchanged list keeps its identity so nothing below re-renders.
- `map-container.tsx` no longer sets `loading` (which shows the overlay) for a refetch when markers are already shown.
- "Keep previous data" applies only when the viewport changes. A change of search text or filters clears the markers as today, so no pin from the old filter can be tapped while the new result loads. *(builder's call)*
- **Fetch a little more than the screen.** Today the request covers exactly the visible area, while a new view inside that area plus 12.5% per side reuses the held data — so after a small pan the newly revealed edge strip has no markers until a bigger move refetches. The request now covers the visible area padded by 25% per side (the same padding the reuse rule already allows), so a pan that reuses the held data always has complete data on screen.
- **Reuse rules (unchanged unless stated):** no refetch when the new view is inside the fetched area, the previous answer was complete (server total not above the limit) and the zoom band did not change. A capped answer refetches on every move — measure how often that happens on the local data at country zoom. The count pill must keep counting the **visible** area: when an answer is capped, its server total describes the larger fetched area, so the pill keeps today's "N+" treatment rather than showing that total as the visible count.
- If measurement confirms cause 5, the marker queries turn off React Query structural sharing (`structuralSharing: false`) — each response is replaced wholesale, which is correct here because the list is rebuilt from scratch anyway.

### 2. Cluster first, in one place shared by both providers

A new hook in `apps/ui/src/components/map/` (working name `useMapClusters`) owns clustering for both providers:

- **Input:** the marker list, the current map bounds and zoom (both providers already report these on idle through `ViewportReporter`), and the self location.
- **Index:** a `supercluster` index built once per marker list (rebuilt only when the list changes), on plain coordinates — no React components, no map elements. Each point carries its marker id and domain; supercluster's map/reduce keeps a per-domain count on every cluster, which replaces the current per-element `markerDomainMap` lookup.
- **Output, per idle:** only what is inside the bounds at that zoom, as two kinds of item:
  - `cluster` — position, total count, per-domain counts, and the zoom to animate to when clicked (`getClusterExpansionZoom`);
  - `point` — a single map point (the existing `MapMarker`).
- **Counts are map points, as today.** A listing with several saved locations is several points, so it can add to more than one bubble; the count pill keeps counting listings. The correctness check compares bubble and pin counts with the points in view, not with the pill. *(builder's call)*
- **Same-coordinate listings stay as today:** `spreadCoLocatedMarkers` still fans them on the 10 m ring before clustering.
- **Group only pins that would overlap, at every zoom.** Clustering stays on up to the map's maximum zoom, and two points merge only when their pins would cover each other on screen (cluster radius about one pin width). Zooming in separates pins as soon as they have room; at maximum zoom, points a couple of metres apart are separate pins. The number of markers drawn is therefore bounded by screen size, never by the number of listings — thousands of nearby listings cannot freeze the map at deep zoom. Only listings at the exact same spot never separate (see "Deferred: same-spot listings"). Both providers use this one rule.

### 3. Each provider draws only the hook's output

- **Google (`google-maps-provider.tsx`):** `ClustererManager`, the per-listing `ClusteredMarker` registration and `MarkerClusterer` are removed. The provider renders one `AdvancedMarker` per `cluster` or `point` item (tens to a few hundred). Cluster content keeps today's look (`buildClusterContent`: count circle plus per-domain chips); the theme colour is resolved once per render, not once per cluster. Cluster click keeps the current camera animation, targeting the expansion zoom. Point click and popups (`InfoWindow` on desktop, `onMarkerSelect` → bottom sheet on mobile) are unchanged.
- **Leaflet (`leaflet-provider.tsx`):** `MarkerClusterGroup` (`react-leaflet-cluster`) is replaced by the same hook; the provider renders one `<Marker>` per item with the existing `divIcon` builders (`createMarkerDivIcon`, `createClusterDivIcon` adapted to take counts instead of child markers). Cluster click zooms to the expansion zoom. Leaflet's spiderfy goes away with `MarkerClusterGroup`; same-spot listings use the 10 m ring like Google.
- **Tourist map:** gets the same clustering through `MapView`; it has no viewport reporter today, so the hook reads bounds and zoom from the map itself on idle in both providers rather than relying on `onViewportChange`. *(builder's call)*
- **Stable props:** marker components are memoised; position, click handlers and icon/content are stable across renders, so a click or popup change re-renders only the affected marker.

### 4. What users will notice

- No freeze on zoom, pan or click; markers stay on screen while new data loads.
- The same kind of cluster bubbles and counts, the same click-to-zoom. Bubbles group fewer pins than today (they merge only when pins would overlap), so more single pins show at city zoom and every pin shows on its own once zoomed in enough, instead of clustering switching off at a fixed zoom.
- After a small pan, listings near the edge are already there; no empty strip.
- At street zoom, all listings in view load (up to 10,000), not only the first 500.
- Leaflet no longer spiderfies same-spot listings; they use the same 10 m ring as Google.

### 5. Street-zoom marker limit

- `lib/map-caps.ts`: the default for `VITE_MAP_MARKER_CAP_INDIVIDUAL` becomes 10,000 (the same as the clustered limit). The 500 existed because clustering switched off at zoom 14 and every pin was drawn; with clustering on and drawing cost tied to what is on screen, that reason is gone.
- With the same limit at every zoom, crossing zoom 14 no longer needs a refetch; the zoom-band rule in `use-map-markers.ts` / `map-viewport-snap.ts` is removed or made a no-op.
- **Deploy config:** dev-signals and the seeker site set `VITE_MAP_MARKER_CAP_INDIVIDUAL: 500` explicitly, so the code default alone changes nothing there. Updating their config is a deploy step, checked after local testing.

## Deferred: same-spot listings

About 2,500 listings share one coordinate on the seeker site. Today they form a solid blob on the 10 m ring where only the top pin can be clicked. This design leaves that behaviour unchanged. After steps 1–3 land, we zoom into the 2,500-listing point locally, measure and look, and then decide. The leading option is to reuse the existing **"Search this area"** flow (`home-page.tsx`): clicking a same-spot bubble opens the existing list view filtered to that spot, which already shows full cards and pages through results — no new list UI.

## Dependencies

- `supercluster` 8.0.1 is already installed as a dependency of `@googlemaps/markerclusterer`; it becomes a direct dependency of `apps/ui` at the same version (plus `@types/supercluster` 7.1.3).
- `@googlemaps/markerclusterer` and `react-leaflet-cluster` are removed from `apps/ui` if nothing else uses them.

## How we verify

- **Same scripted test** as the baseline, on the same 14,300 local listings, for both providers, before and after each step (1 → 2 → 3), recorded on the PR. Run against a local production build of the UI as well as the dev server, so numbers are comparable with the seeker site.
- **Targets (local production build, both providers):** no frame over 200 ms during zoom-out or pan after the response has arrived; markers never drop to zero during a refetch; marker click opens the popup within 100 ms.
- **Correctness checks:** sum of bubble and pin counts in view equals the map points in view; no pin pair overlaps on screen except same-spot listings; a small pan shows edge listings without a refetch; at street zoom on the seeded points all listings load (not 500); tourist map, self marker, recenter, count pill, "Search this area" and mobile bottom sheet behave as today.
- **Unit tests:** the hook (bounds filtering, counts and per-domain counts, expansion zoom, rebuild only on list change), `use-map-markers` (previous data kept on viewport change and cleared on filter change, list identity stable across pans, request bbox padded 25%, no refetch for a pan inside it, count pill still counts the visible area), `map-caps` (new default), and the provider tests updated for the new rendering.
- One check on dev after deploy.

## Left to the builder

- File and function names, how the hook splits internally, and exact memoisation boundaries.
- Whether step 1's structural-sharing change is needed (decide from the measurement).
- Order of commits, as long as each step can be measured on its own.
