# orange_dot Tourist Discovery UI — Design

**Date:** 2026-06-11
**Branch:** `orange-dot-tourist-ui` (off `feature`)
**Status:** Draft for review

## Goal

A standalone, **login-free** tourist UI for the `orange_dot` network: a visitor opens the
web app, the browser asks for their location, and they see and discover practitioners
around them on a map (and in a nearest-first list). There are no
profiles, no profile creation, no "my actions", no sidebar, and no auth. Each practitioner
card offers exactly three actions: **Call**, **Website**, **Get Directions**.

## Context & key findings

This design follows analysis of the existing `apps/ui` (React 19 + Vite) and `apps/api`
(Fastify) code. Two findings shape it:

1. **The backend needs zero changes.** Auth middleware is registered *selectively* (only
   on `admin` / `aggregator` / `action` routes), not globally. `GET /api/v1/network/schemas`
   and `GET /api/v1/network/item/fetch` are already reachable anonymously. For an
   `orange_dot` practitioner read, the response includes `contact_phone`, `website`, and
   `item_locations` (`{lat,lng,label}[]`) in the public item state — `item_private_state`
   is never exposed, and neither `contact_phone` nor `website` is marked `private` in the
   practitioner schema. So a no-login UI can fetch everything it needs as-is.
2. **The UI's map, cards, geolocation, filters, and fetch clients are reusable leaf
   modules.** The "separation" is therefore a UI-only concern — the tourist app talks to
   the existing, unchanged signals-dpg API configured to serve `orange_dot`.

The practitioner location field is `area` (`location: "single"`, **not** `private`), so it
is an exact point — Get Directions can target the practitioner's precise coordinates.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Separation scope | **UI-only** now. No backend fork. Backend stays shared/unchanged. |
| Where the code lives | **Second Vite build entry inside `apps/ui`** (`VITE_APP=tourist`). |
| Views | **Map + nearest-first list**, switched via a Map/List toggle in the app bar. |
| Geolocation denied/unavailable | **Show all practitioners on a region-default center** + a banner offering "Enable location". |
| Practitioner location precision | Exact (`area` is not coarsened). |
| Get Directions | Platform-aware: Android `geo:` chooser / iOS Apple Maps / desktop Google Maps directions URL. |
| Phone | `tel:` link, `+91` prefix for bare 10-digit numbers (configurable). |
| Region default center | Udupi `{ lat: 13.3409, lng: 74.7421 }`, zoom 12 (override via `VITE_TOURIST_DEFAULT_CENTER`). |

## Architecture

A **second, self-contained Vite entry** inside `apps/ui`, built and deployed independently
from the signals SPA. The signals app is never modified; the tourist app is purely additive
and dormant unless `VITE_APP=tourist` is set.

- New entry `apps/ui/index.tourist.html` → `apps/ui/src/tourist/main.tourist.tsx`.
- `vite.config.ts` reads `import.meta.env`/`process.env` `VITE_APP`: when `=== 'tourist'`,
  the build/dev input is `index.tourist.html` only (its own `dist/`); otherwise the build
  is byte-for-byte the existing signals app (default branch). This is the **only** shared
  file the design changes, and the change is a no-op when the flag is unset.
- New scripts in `apps/ui/package.json` (and root aliases): `dev:tourist`, `build:tourist`,
  which set `VITE_APP=tourist` and `VITE_NETWORK_ID=orange_dot`.
- No backend changes. The tourist app calls the existing API anonymously:
  - `GET /api/v1/network/schemas?network=orange_dot` (network config + practitioner schema)
  - `GET /api/v1/network/item/fetch?item_network=orange_dot&item_domain=practitioner&item_type=profile_1.0&limit=100`

Everything under `apps/ui/src/tourist/` is a contained tree that can be lifted into its own
repo later without touching the signals app.

## Layout

A full-width **app bar** on top, full-width content below — **no sidebar**.

```
┌───────────────────────────────────────────────────────────┐
│  [search…]  [Filters ▾]            [Map|List]  [🌐] [🌓]    │  ← app bar (no auth, no sidebar trigger on desktop)
├───────────────────────────────────────────────────────────┤
│                                                             │
│   MapView (full width)   — or —   nearest-first List        │
│                                                             │
└───────────────────────────────────────────────────────────┘
```

- App bar keeps: search, filters control, Map/List toggle, language switcher, theme toggle.
- App bar removes: sidebar trigger, Log In, UserMenu, notification bell, network/domain/profile selectors.

## Components

### Reused (imported read-only; not modified)
- `components/map/map-container.tsx` (`MapView`) — `center`, `zoom`, `items`, `focusPoint`,
  `renderPopup`, `resolveMarkerLabel`.
- `components/map/map-filters-panel.tsx` (`MapFiltersPanel`) — the filters control.
- `lib/enum-filters.ts` — `getEnumFilterFieldsForDomains`, `itemPassesEnumFilters`; plus the
  search-text filter (same pipeline as `home-page.tsx:632–672`).
- `components/cards/item-card.tsx` + `resolve-card-fields.ts`.
- `hooks/use-browser-location.ts`, `hooks/use-user-location.ts` — calling
  `useUserLocation(null, true)` auto-requests browser geolocation once on load (no profile path).
- `lib/geo/distance.ts` — `nearestDistanceMeters` for the list sort.
- `lib/network-api.ts` (`fetchNetworkConfig`, `fetchNetworkItems`), `lib/item-api.ts` (`Item`).
- UI primitives: `Input`, `ToggleGroup`, `LanguageSwitcher`, `ThemeModeToggle`.

### New (`apps/ui/src/tourist/`)
- `main.tourist.tsx` — entry; mounts `<TouristApp/>` into `#root` with `QueryClientProvider`,
  theme, and i18n. **No** `AuthProvider`, **no** sidebar/router providers.
- `tourist-app.tsx` — orchestration. Fetches the network config + practitioners (React Query),
  resolves location via `useUserLocation(null, true)`, owns `search` / `viewMode` / filter
  state, runs the search + enum-filter pipeline to produce the filtered item set, and feeds
  both map and list. Owns the denied/loading/error/empty states.
- `tourist-top-bar.tsx` — slim app bar composing the **same leaf controls** as the signals
  `TopBar` (search `Input`, Map/List `ToggleGroup`, `MapFiltersPanel` slot, `LanguageSwitcher`,
  `ThemeModeToggle`) **without** the auth/sidebar/router dependencies (`TopBar` itself calls
  `useNavigate`/`useAuth`/`SidebarTrigger`, so it is not reused directly).
- `tourist-map.tsx` — `MapView` with practitioner markers; `focusPoint` = tourist location, or
  the region default center when location is unknown. Popup renders `PractitionerCard`.
- `tourist-list.tsx` — filtered practitioners as `PractitionerCard`s, sorted nearest-first when
  location is known (unsorted otherwise).
- `practitioner-card.tsx` — wraps `ItemCard`, supplies the three action buttons via the card's
  `actions` slot.
- `enable-location-banner.tsx` — shown when geolocation is denied/unavailable: explains all
  practitioners are shown and offers an "Enable location" button that re-calls `request()`
  from a user gesture.

## The three actions

Implemented in `lib/geo/directions.ts` (pure helpers) + click handlers in `practitioner-card.tsx`.
Each button is **hidden** when its underlying field is absent on the practitioner.

- **Call** — `<a href="tel:+91{contact_phone}">`. A bare 10-digit number is prefixed with
  `+91`; a number already carrying a `+`/country code is used as-is. Opens the phone dialer.
- **Website** — opens `website` in a new tab (`target="_blank" rel="noopener noreferrer"`),
  normalizing to `https://` when no scheme is present.
- **Get Directions** — targets the practitioner's exact `area` coordinates
  (`item_locations[0]`):
  - **Android** (`/android/i` UA): `geo:{lat},{lng}?q={lat},{lng}({label})` — triggers the OS
    "open with…" map-app chooser (Google Maps, etc.).
  - **iOS** (`/iphone|ipad|ipod/i` UA): `maps://?daddr={lat},{lng}` — opens Apple Maps with the
    destination set.
  - **Desktop / fallback**: `https://www.google.com/maps/dir/?api=1&destination={lat},{lng}`
    opened in a new tab.

## Data flow & states

On load, the app fetches the config + practitioners and auto-requests location in parallel.

- **Location granted** → map `focusPoint` = tourist coords; all practitioners shown; list
  sorted nearest-first.
- **Location denied / unavailable** → map `focusPoint` = region default center; all
  practitioners shown; `enable-location-banner` offers to enable (re-centers + sorts on grant).
- **API error** → error state with a Retry action.
- **No practitioners** → empty state.
- No hard distance radius for the pilot — proximity is conveyed by centering + nearest-first.

A practitioner with no `item_locations` is omitted from the map (no marker) but still appears
in the list (sorted last); its Get Directions button is hidden.

## Error handling

- Routes never crash on missing fields: each action button is conditional on its field.
- Geolocation errors are surfaced through the existing `useBrowserLocation` status/error and
  drive the banner — they never block rendering (graceful degradation to region default).
- Fetch failures show a retryable error state; React Query handles retry/loading.

## Testing

- **Unit** — `lib/geo/directions.ts`: UA → URL mapping for Android / iOS / desktop; `tel:`
  prefixing; website scheme normalization. Pure functions, fully testable.
- **Reuse** — `lib/geo/distance.ts` behavior for the nearest-first sort (already covered by its
  own logic; add a focused test if absent).
- **Component** — `practitioner-card.tsx`: renders only the buttons whose fields exist and wires
  the correct `tel:` / website / directions targets. (Confirm the UI package's test setup —
  vitest + RTL — during planning; if RTL is not configured, keep the directions unit tests as
  the minimum bar and note the gap.)

## Build targets

The design changes one shared file (`vite.config.ts`) and adds new files/scripts. With
`VITE_APP` unset, the signals build is unchanged and the tourist code is dormant.

| Goal | Env |
|---|---|
| Orange **tourist** UI | `VITE_APP=tourist` (→ `orange_dot`, no login, map + list) |
| Any signals dot (incl. orange-as-signals) | *(no `VITE_APP`)* + `VITE_NETWORK_ID=<dot>` |

## Out of scope (deferred)

- Any backend/API fork or orange-specific backend behavior.
- Any write path — no profiles, profile creation, actions, or login, ever.
- In-app "soft" consent pre-prompt before the native geolocation prompt (app-level consent is
  tracked separately in #91 / #92 / #93); the tourist app uses the native prompt only.
- Distance-radius filtering.
- Multi-network — the tourist app serves `orange_dot` only.
