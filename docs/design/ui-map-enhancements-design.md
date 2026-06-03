# UI Map Enhancements — Design

Five focused improvements to the map view on the home page. Each is independently shippable.

> The current map code lives in [apps/ui/src/components/map/](../../apps/ui/src/components/map/) — see [ui-location-geocoding-review.md](./ui-location-geocoding-review.md) for an overview of how it's wired today.

---

## 1. Domain-based marker icons

Replace the single colored pin used today with different icons for `seeker` vs `provider`. This is the simple v1; in a later iteration we may drive icons from a schema-declared field (e.g. `looking_for` for purple_dot), but that's deferred.

**Approach**

- Add a `domain` field to [`MapMarker`](../../apps/ui/src/engine/types.ts) and populate it in `resolveMarkers` from the item being processed.
- Each map provider picks the icon by `marker.domain`. Lucide React (already a dependency) gives us a wide set — e.g. `User` for seekers, `Building2` for providers — rendered inside the existing colored circles.
- Default fallback for unknown domains: the current single pin, so the map still works for any network.

**Touchpoints**

- [engine/types.ts](../../apps/ui/src/engine/types.ts) — extend `MapMarker`
- [components/map/map-container.tsx](../../apps/ui/src/components/map/map-container.tsx) — populate the new field in `resolveMarkers`
- [components/map/providers/leaflet-provider.tsx](../../apps/ui/src/components/map/providers/leaflet-provider.tsx) and [google-maps-provider.tsx](../../apps/ui/src/components/map/providers/google-maps-provider.tsx) — render the right icon

---

## 2. Marker clustering for co-located items

Today, multiple profiles sharing the same coordinates render as a single pin, hiding the rest. We solve this with **clustering + spiderfy**: nearby markers collapse into a counted badge at low zoom, and exactly-overlapping markers fan out in a circle when the cluster is clicked.

**Approach**

- Leaflet: use [`react-leaflet-cluster`](https://www.npmjs.com/package/react-leaflet-cluster). Single component (`<MarkerClusterGroup>`) wraps the existing markers, supports spiderfying out of the box.
- Google: use [`@googlemaps/markerclusterer`](https://www.npmjs.com/package/@googlemaps/markerclusterer) via a small wrapper.
- Each individual pin (after spiderfy) is still clickable and opens the existing popup — no change to the popup wiring.

**Touchpoints**

- [providers/leaflet-provider.tsx](../../apps/ui/src/components/map/providers/leaflet-provider.tsx) and [google-maps-provider.tsx](../../apps/ui/src/components/map/providers/google-maps-provider.tsx) — wrap the marker list in the cluster component
- One new dev dependency per provider

---

## 3. Improved popup card

Same data we show today, but redesigned to look like the reference card (clean white surface, avatar/initials, structured key-value rows, subtle shadow, no PII reveal). No schema changes.

**Approach**

- A new shared component, e.g. `<MarkerPopupCard marker={…} />` that:
  - Reads `marker.label` (display name) and `marker.data` (already privacy-filtered public fields).
  - Shows an avatar circle with the first letter of the name.
  - Shows the domain (purple_dot's "seeker"/"provider") as a chip.
  - Renders the top N public fields as label/value rows.
- Both providers' popups (`<Popup>` in Leaflet, `<InfoWindow>` in Google) embed the same component, so the look stays consistent.
- All styling via Tailwind + shadcn (consistent with the rest of the app).

**Touchpoints**

- New: `components/map/marker-popup-card.tsx`
- [providers/leaflet-provider.tsx](../../apps/ui/src/components/map/providers/leaflet-provider.tsx) and [google-maps-provider.tsx](../../apps/ui/src/components/map/providers/google-maps-provider.tsx) — replace the inline popup markup with the new component

---

## 4. Initial map viewport based on the logged-in user

Today `FitBounds` zooms out to encompass every marker in the dataset — if items are scattered, you see all of India. The new behaviour focuses the initial view on the user's own profile(s).

**Approach**

- On `MapView` mount, fetch the user's own items via the existing `GET /api/v1/item/fetch?created_by_me=true` (the home page already calls this).
- Decide the initial center using:
  - **One own profile** → center on that profile's coords, zoom level ~12 (city level).
  - **Multiple own profiles** → default to the **first** profile, but render a small dropdown in the top-left ("Showing: Profile A ▾") with all own profiles plus an **"All items"** option that restores today's fit-to-all behaviour.
  - **No own profile** → center on the network's default location (India centroid `(20.59, 78.96)`, zoom 5). The map still shows other users' items as before.
- Once the user interacts (pan/zoom), don't override their viewport.

**Touchpoints**

- [components/map/map-container.tsx](../../apps/ui/src/components/map/map-container.tsx) — accept an optional `initialCenter` / `initialZoom` and a "Showing" selector
- A small dropdown component added inside the map overlay (top-left, near the future Filters control)

---

## 5. Filters panel — status + domain

A "Filters" pill in the top-left of the map opens a sliding panel with two filter groups: **status** (`new` / `active` / `at_risk` / `inactive`) and **domain** (the network's domains). Sort is not in v1.

**Generic, not hardcoded per network.** The list of statuses comes from the active network's `status_rules` in `network.json`. The list of domains comes from `network.domains`. Both are already loaded into the UI via the existing network-config fetch, so no new API is needed.

**Approach**

- **Item status is derived**, not stored on the items table. We compute it client-side from `status_rules` + the item's `created_at` / `updated_at` / action history. A small helper (`deriveItemStatus(item, networkConfig)`) lives next to the existing item-utils. If we later expose `profile_status` from the `item_metrics` table on the fetch response, the helper becomes a pass-through and nothing else changes.
- **Shared filter state** for the map and the list view: extend the existing [`filteredDomainItems` memo in home-page.tsx](../../apps/ui/src/pages/home-page.tsx) so it also takes filter state, and both views consume the result.
- **Filter UI** is a controlled popover with check-box chips for each option. Clicking outside or pressing Esc closes it. State lives in URL search params (e.g. `?status=active,new&domain=seeker`) so filters survive a refresh.

**Touchpoints**

- New: `components/map/filters-panel.tsx`
- New: `lib/item-status.ts` (the `deriveItemStatus` helper)
- [pages/home-page.tsx](../../apps/ui/src/pages/home-page.tsx) — lift filter state, extend `filteredDomainItems`, pass filters to both list and map
- [components/map/map-container.tsx](../../apps/ui/src/components/map/map-container.tsx) — render the filters pill in the overlay

---

## Suggested rollout order

The five features are independent. A sensible order is the one that lands user-visible value soonest with the least risk:

1. **Initial viewport** (item 4) — small, immediately improves the first impression of the map.
2. **Clustering** (item 2) — small, unblocks the "everyone is in Bengaluru" overlap that's confusing today.
3. **Domain icons** (item 1) — small visual change, builds on the marker shape.
4. **Popup redesign** (item 3) — medium visual change, no behaviour change.
5. **Filters panel** (item 5) — largest piece; depends on the status-derivation helper.

Each step is an independent PR. Stopping after any one of them still leaves the map better than today.
