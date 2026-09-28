# Mobile Discovery Layout (#745) Implementation Plan

**Goal:** Give phone users (< 768px) a purpose-built discovery layout matching the GZB prototype (<https://gzbsignalsdiscoverymap.lovable.app>) — compact top bar, domain chip row, full-screen map, and a draggable results bottom sheet whose header carries the Map/List toggle, the listing count and Filters. Desktop is unchanged.

**Branch:** `feat/745-mobile-discovery-layout` (off `feature`).

**Tech:** React 19, Vite, Tailwind v4, vitest + @testing-library/react + happy-dom. No new dependencies.

## Prototype reference (observed at 390×844, 2026-09-24)

| Element | Behaviour |
|---|---|
| Top bar (56px) | Search + hamburger only. Language / theme / notifications are not in the bar. |
| Hamburger | Slide-out: brand, My Profile(s), Discover, My Actions, **Preferences** (theme, language). |
| Domain chips | 44px, horizontally scrolling, **single-select**: `All / Seekers / Providers / Service Providers`. |
| Guest banner | "Sign in" banner between the chips and the map. |
| Map | Full width, clustered pins; tapping a cluster leaves the sheet at peek. |
| Results sheet | Three snap points — **peek** (~100px: handle + header), **half** (~47% of the viewport), **full** (just under the chips). |
| Toggle ↔ snap | Peek = **Map**; half and full = **List**. Tapping List goes to full, Map to peek. |
| Sheet header | `[Map \| List]` (icon + text) · "N listings" · round Filters button. |
| Filters | Full-height drawer, facet chip groups, sticky footer **Clear all** / **Show N results**. |
| Card | Avatar header with title + domain badge, label/value rows, full-width "View more details", then Match Score / Apply. |

Prototype defect **not** to copy: its sheet is a vaul drawer, which wraps a *modal* Radix Dialog even with `modal={false}` — every element outside the sheet (search, chips) is `aria-hidden` and focus is trapped.

## Decisions

| # | Question | Decision |
|---|---|---|
| D1 | Viewport range | Below 768px, via the existing `useIsMobile()`. |
| D2 | "All" chip | Map only. The list stays single-domain (#644). With the sheet at half/full the chip row shows the domains only; opening the list with "All" active keeps the current list domain. A mixed-domain list is a follow-up ticket. |
| D3 | Sort and area/radius (absent in the prototype) | Kept, in a second row of the sheet header — visible once the sheet is raised. Not in the Filters drawer: Radix popovers (`z-50`) would render under the `z-[1200]` drawer. |
| D4 | Snap points | Three, as the prototype. Peek ⇄ `viewMode='map'`, half/full ⇄ `'list'`. |
| D5 | Bulk select | Kept inside the sheet (the bar is `sticky` in the sheet's scroll area). |
| D6 | Sheet implementation | Custom component (pointer-drag on the handle/header, CSS transform), `role="region"`, not vaul — see the defect above. |
| D7 | Hamburger side | Stays on the left (existing sidebar). Discover is not duplicated into the menu — the chip row is always on screen. |

## File structure

**Created**
- `apps/ui/src/components/discovery/mobile/results-sheet.tsx` — the sheet (snap state, drag, expand/collapse button).
- `apps/ui/src/components/discovery/mobile/results-sheet-header.tsx` — Map/List toggle, count, Filters slot.
- `apps/ui/src/components/discovery/mobile/domain-chip-row.tsx` — single-select chips with optional "All".
- Tests beside each under `__tests__/`.

**Modified**
- `pages/home-page.tsx` — `useIsMobile()` switch; list/map JSX split into two render functions so the phone layout can show both; chip handler.
- `components/layout/page-shell.tsx` — `compactTopBar` and `fillContent` props.
- `components/layout/top-bar.tsx` — `compact` prop.
- `components/layout/sidebar.tsx` — `showPreferences` (theme + language group).
- `components/map/map-container.tsx` — `showMaximize` prop.
- `components/map/map-count-pill.tsx` — `className` passthrough for the phone offset.
- `components/filters/browse-filters-panel.tsx` — phone drawer full-height + footer (`resultCount`).
- `components/filters/browse-toolbar.tsx` — `variant="sheet"` (no domain control, no count, no filters slot).
- `components/ui/responsive-dialog.tsx` — `drawerClassName`.
- `i18n/locales/{en,hi,kn}.json` — new keys.

## Tasks

- [x] **1. Shell props.** `PageShell.compactTopBar` → `TopBar compact` (hide view toggle and inline language/theme; search takes row one; login icon-only) and `AppSidebar showPreferences` (theme + language group, phone only). `PageShell.fillContent` → `<main>` without padding/scroll, `flex flex-col overflow-hidden`, so the map can fill it.
- [x] **2. Domain chip row.** Single-select chips, `aria-pressed`, labelled group, 44px, horizontal scroll. "All" rendered only when `showAll`.
- [x] **3. Results sheet.** `snap: 'peek' | 'half' | 'full'`, controlled. Positioned `absolute` inside the fill area so "full" ends under the chips at any chrome height. Drag on the handle/header only (`touch-action: none`); nearest snap on release with a velocity bias. Expand/collapse button for non-drag users. List scrolls inside the sheet.
- [x] **4. Sheet header.** `[Map | List]` toggle (icon + text), "N listings", Filters slot; second row = `BrowseToolbar variant="sheet"`.
- [x] **5. Home page wiring.** On phones: chip row as `toolbarSlot`; map fills the area; sheet holds the list. `snap` derived from `viewMode` (peek ⇄ map, half/full ⇄ list) through `handleViewModeChange`, so `?view=` and the list domain collapse keep working. Count pill and "Search this area" lifted above the peek and hidden when raised; partial banner moved below the chips; map maximize hidden.
- [x] **6. Filters drawer.** Phone: full height, groups scroll, sticky footer Clear all / "Show N results" (closes the drawer).
- [x] **7. i18n.** `discover.results`, `discover.view_map`, `discover.view_list`, `discover.expand_results`, `discover.collapse_results`, `discover.all_domains`, `filters.show_results`, `menu.preferences` in en / hi / kn.
- [x] **8. Tests.** Sheet snap ⇄ toggle; drag snapping; chip selection and "All" visibility; header count; filters footer; phone vs desktop home layout; search and chips not `aria-hidden` while the sheet is open; `no-raw-vh-units` still green.
- [x] **9. Manual QA.** 390×844, 320×568, 390×640 on Leaflet and Google; signed in and signed out.

## Risks

- **Drag vs scroll.** Only the handle/header drags; the list scrolls natively.
- **First render.** `useIsMobile()` is `false` on the first render, so phones briefly render the desktop layout.
- **Layering.** Sheet `z-30` (below the top bar `z-40`, popovers `z-50`, dialogs `z-[1200]`). The map wrapper is `isolate`, so Leaflet panes stay contained. Fixed overlays at `z-[2100]` (count pill, "Search this area", partial banner) need the phone offsets in Task 5.
