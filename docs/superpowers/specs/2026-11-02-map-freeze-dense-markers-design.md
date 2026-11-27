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
- Every listing in view is counted in a cluster and is reachable: by zooming in, or, for listings at one spot or too close together to separate, through the list (section 6).
- The street-zoom marker limit no longer cuts listings off: the code default for zoom 14 and above rises from 500 to 10,000, the same as the clustered limit.
- The cost of drawing the map depends on what is on screen, not on how many listings were fetched.

## Non-goals

- Server responses, compression and caching (#880), duplicate requests at load (#881), the stale marker cache (#845).
- Server-side clustering or state → district → pin bubbles (kept as a last resort, only if this design is not enough).
- Lowering the marker cap.
- The cluster-icon overlap and map-height layout items listed in #854's description.

## Anti-goals (a failure even if it gets faster)

- Any listing in view that cannot be reached on the map.
- Cluster counts that do not add up to the listings in view.
- Popups, the mobile bottom sheet, the "You are here" marker, the recenter button, the count pill or the "Search this area" button behaving differently from today (other than the button's new label, section 6).
- The tourist map (`tourist/tourist-map.tsx`, orange_dot) breaking — it uses the same `MapView`.
- A new API endpoint or any API change.

## Design

### 1. Keep markers while loading; build the marker list only when the data changes

- `use-map-markers.ts`: the marker queries keep the previous result while the next one loads (React Query `placeholderData: keepPreviousData`), so the list never drops to empty during a refetch.
- `use-map-markers.ts`: the merged marker list depends only on the fetched data. The visible-area count (`total`) is computed separately, so a pan changes the count, not the list.
- `home-page.tsx` (`mapItems`) and `map-container.tsx` (`resolveMarkers`) create marker objects once per data change; an unchanged list keeps its identity so nothing below re-renders.
- `map-container.tsx` no longer sets `loading` (which shows the overlay) for a refetch when markers are already shown.
- "Keep previous data" applies only when the viewport changes. A change of search text or filters clears the markers as today, so no pin from the old filter can be tapped while the new result loads. *(builder's call)*
- **Fetch a little more than the screen.** Today the request covers exactly the visible area, while a new view inside that area plus 12.5% per side reuses the held data — so after a small pan the newly revealed edge strip has no markers until a bigger move refetches. The request now covers the visible area padded by 25% per side, and a new view reuses the held data only while it stays inside that fetched area, so a pan that reuses the held data always has complete data on screen.
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
- **Same-coordinate listings are no longer fanned out.** `spreadCoLocatedMarkers` (the 10 m ring) is removed; listings at one spot stay at that spot and form one bubble (section 6).
- **Cluster at every zoom, with an 80 px merge distance.** Clustering stays on up to the map's maximum zoom; points closer than 80 screen pixels merge (Leaflet's radius before this change). Zooming in separates pins as soon as they are 80 px apart. The number of markers drawn is bounded by screen size, never by the number of listings. *(Changed from "merge only when pins overlap" (~32 px) after measuring the seeded data: 32 px put 390–480 markers on one city screen, 80 px at most ~95.)* Only listings at one spot, or too close to separate at the maximum zoom, never separate (section 6). Both providers use this one rule.
- **No special case at the maximum zoom.** The earlier rule that drew a bubble of 50 or fewer as individual pins at the maximum zoom is removed: on the 10 m ring it produced overlapping pins that could not be told apart. A bubble that cannot split opens the same-spot card instead (section 6).

### 3. Each provider draws only the hook's output

- **Google (`google-maps-provider.tsx`):** `ClustererManager`, the per-listing `ClusteredMarker` registration and `MarkerClusterer` are removed. The provider renders one `AdvancedMarker` per `cluster` or `point` item (tens to a few hundred). Cluster content keeps today's look (`buildClusterContent`: count circle plus per-domain chips); the theme colour is resolved once per render, not once per cluster. Cluster click keeps the current camera animation, targeting the expansion zoom. Point click and popups (`InfoWindow` on desktop, `onMarkerSelect` → bottom sheet on mobile) are unchanged.
- **Leaflet (`leaflet-provider.tsx`):** `MarkerClusterGroup` (`react-leaflet-cluster`) is replaced by the same hook; the provider renders one `<Marker>` per item with the existing `divIcon` builders (`createMarkerDivIcon`, `createClusterDivIcon` adapted to take counts instead of child markers). Cluster click zooms to the expansion zoom. Leaflet's spiderfy goes away with `MarkerClusterGroup`; same-spot listings get the same-spot card like Google (section 6).
- **Tourist map:** gets the same clustering through `MapView`; it has no viewport reporter today, so the hook reads bounds and zoom from the map itself on idle in both providers rather than relying on `onViewportChange`. *(builder's call)*
- **Stable props:** marker components are memoised; position, click handlers and icon/content are stable across renders, so a click or popup change re-renders only the affected marker.

### 4. What users will notice

- No freeze on zoom, pan or click; markers stay on screen while new data loads.
- The same kind of cluster bubbles and counts, the same click-to-zoom. Bubbles group fewer pins than today (they merge only when pins would overlap), so more single pins show at city zoom and every pin shows on its own once zoomed in enough, instead of clustering switching off at a fixed zoom.
- After a small pan, listings near the edge are already there; no empty strip.
- At street zoom, all listings in view load (up to 10,000), not only the first 500.
- Listings at one spot (or in one building) show as one bubble at every zoom; clicking it explains why and opens them in the list (section 6). Leaflet no longer spiderfies them.

### 5. Street-zoom marker limit

- `lib/map-caps.ts`: the default for `VITE_MAP_MARKER_CAP_INDIVIDUAL` becomes 10,000 (the same as the clustered limit). The 500 existed because clustering switched off at zoom 14 and every pin was drawn; with clustering on and drawing cost tied to what is on screen, that reason is gone.
- With the same limit at every zoom, crossing zoom 14 no longer needs a refetch; the zoom-band rule in `use-map-markers.ts` / `map-viewport-snap.ts` is removed or made a no-op.
- **Deploy config:** dev-signals and the seeker site set `VITE_MAP_MARKER_CAP_INDIVIDUAL: 500` explicitly, so the code default alone changes nothing there. Updating their config is a deploy step, checked after local testing.

### 6. Listings at one spot, or too close to separate

**Chosen with the user on 2026-11-03** from the same-spot prototype: option A for every group of 2 or more listings, no flip cards, and the label rename.

- **Which bubbles.** A bubble *cannot split* when zooming in would never separate it: its expansion zoom is beyond the provider's maximum clustering zoom (Google 20, Leaflet 18). That covers listings at one exact coordinate and listings a few metres apart, e.g. in one building. The clustering output marks such a bubble, and whether all its listings share one exact coordinate (to 6 decimal places).
- **Click.** A bubble that cannot split no longer zooms (today the click does nothing at the maximum zoom). At any zoom, clicking it opens the same-spot card. Every other bubble keeps today's click-to-zoom. *(builder's call: from far out the card opens straight away, rather than first zooming to a level where the click would still do nothing)*
- **The card.** Desktop: anchored to the bubble, like today's listing popup (Google `InfoWindow`, Leaflet popup). Phone: a bottom sheet, like today's listing sheet. It shows:
  - title: "{{count}} listings at this exact spot", or "{{count}} listings very close together" when the coordinates are not all identical;
  - one sentence: they share one location / are too close together, so the map can't show them one by one, even zoomed in fully;
  - the per-type counts already on the bubble (e.g. "1,200 Provider · 2 Service Provider");
  - one button, "View these {{count}} in the list", plus close (✕ on desktop, Close on the sheet).
- **The list.** The button switches to the list view, scoped to the group with the list's existing area filter: a `viewport` area whose bounds are the group's points, padded by about 5 m per side so a zero-size box at one exact coordinate still matches. Same request as "Search this area" — **no API change**. Sort, filters, the domain tabs and paging work as everywhere else in the list and apply only to the group; signed-in users keep Relevance as the default.
  - The list shows a banner above the results: "Showing the listings at this spot" (or "...very close together") with a **Back to map** button. Back to map clears the area and returns to the map at the same view.
  - The area menu shows the group instead of "The area shown on the map", so the active area reads correctly. The area chip works as today (removing it clears the area).
  - The list counts what the server finds in that box. When the map's fetch was capped, that can be more than the bubble showed; the list's own count is what is shown. *(builder's call)*
  - The list opens on the current domain tab if the group has listings of that type, otherwise on the group's largest type. *(builder's call)*
- **Rename.** The map's "Search this area" button becomes **"List what's in this view"**. Same behaviour, same conditions for showing; only the label changes, including the guided tour text that names it.
- **Translations.** Every new or changed string goes into every locale file in `apps/ui/src/i18n/locales/` (en, hi, kn), so enabling a language needs no further work. Kannada is retained but switched off today; it still gets the strings.
- **"You are here".** The ring also lifted a single listing off the viewer's own coordinate so the "You are here" marker did not hide it. With the ring gone, listing pins and bubbles are drawn above the "You are here" marker instead, so they stay clickable. *(builder's call)*
- **Both providers, desktop and phone.** Same rule, same card and same list behaviour on Google and Leaflet; the phone layout (bottom sheet, tap targets, nothing cut off at 390×844) is checked in the browser.

## Dependencies

- `supercluster` 8.0.1 is already installed as a dependency of `@googlemaps/markerclusterer`; it becomes a direct dependency of `apps/ui` at the same version (plus `@types/supercluster` 7.1.3).
- `@googlemaps/markerclusterer` and `react-leaflet-cluster` are removed from `apps/ui` if nothing else uses them.

## How we verify

- **Same scripted test** as the baseline, on the same 14,300 local listings, for both providers, before and after each step (1 → 2 → 3), recorded on the PR. Run against a local production build of the UI as well as the dev server, so numbers are comparable with the seeker site.
- **Targets (local production build, both providers):** no frame over 200 ms during zoom-out or pan after the response has arrived; markers never drop to zero during a refetch; marker click opens the popup within 100 ms.
- **Correctness checks:** sum of bubble and pin counts in view equals the map points in view; no two pins overlap on screen; a bubble that cannot split opens the same-spot card at any zoom on both providers, desktop and phone, and its button opens the list with only that group's listings (Tumkur seed: 1,400 at one point, 3 at another); a small pan shows edge listings without a refetch; at street zoom on the seeded points all listings load (not 500); tourist map, self marker, recenter, count pill, "List what's in this view" and mobile bottom sheet behave as today.
- **Unit tests:** the hook (bounds filtering, counts and per-domain counts, expansion zoom, rebuild only on list change, which bubbles cannot split and whether they are one exact spot), `use-map-markers` (previous data kept on viewport change and cleared on filter change, list identity stable across pans, request bbox padded 25%, no refetch for a pan inside it, count pill still counts the visible area), `map-caps` (new default), the provider tests updated for the new rendering and the same-spot click, the card on desktop and phone, the list scoping and its banner, and every new string present in every locale file.
- One check on dev after deploy.

## Left to the builder

- File and function names, how the hook splits internally, and exact memoisation boundaries.
- Whether step 1's structural-sharing change is needed (decide from the measurement).
- Order of commits, as long as each step can be measured on its own.
