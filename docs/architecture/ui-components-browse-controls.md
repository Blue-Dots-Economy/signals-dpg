# UI browse controls: toolbar, sort, location, domain, chips

Describes `apps/ui/src/components/filters/` — `BrowseToolbar`, `SortSelect`,
`LocationSelect`, `LocationSourceSelect`, `OptionSelect`, `DomainControl`,
`AppliedFilterChips` and `BrowseFiltersPanel`.

## Editors vs read-out

The app bar owns the editors for search text; `BrowseFiltersPanel` is the facet
editor. The browse toolbar owns the read-out (applied chips, count) plus the
controls that have no other home: domain, sort and location. Nothing in the
toolbar edits something the app bar already edits.

`AppliedFilterChips` formats nothing and owns no filter state; it reports
removals to the caller. It shows chips only for constraints whose editor is
elsewhere (search text, facets). Sort and area have their own controls in the
same row, so a chip for them would duplicate the visible value. For the same
reason clear-all lives in the toolbar: it must be reachable when sort or area
is non-default even though neither produces a chip.

The toolbar always renders (showing "no filters applied" when empty) so its
height is stable and the list does not shift as chips come and go. It is not
`sticky`; `PageShell` renders it as a sibling of the scrolling `<main>`, so it
is structurally pinned.

## List vs map

- Domain: single-select on the list (one `/discover` call takes one
  `item_domain`), multi-select on the map (one `/markers` request per domain).
  Neither mode can reach an empty selection. Callers pass only the domains the
  viewer can browse; `computeVisibleDomains` still governs what is fetchable.
  With one browsable domain the control renders as the page `<h1>` instead.
- Sort: absent on the map. Ordering is meaningless for a marker layer, and a
  disabled control invites the question rather than answering it.
- Area (radius): absent on the map. The viewport is the map's spatial filter
  (`useMapMarkers` takes the viewport, not `area`), so a radius would be inert,
  and if wired up would contradict the viewport (a 5 km circle inside a 200 km
  viewport paints an empty map). The list needs the area filter because it is
  the escape hatch from a map too dense to show every pin.
- Location source: present on both. On the map it decides where the map opens,
  where "You are here" sits, and re-centres the map when changed, so the map
  renders it alone as `LocationSourceSelect`. That is a separate component, not
  a variant of `LocationSelect`, because nothing else of `LocationSelect`
  (radius field, validation, viewport row) applies; both build on
  `OptionSelect` for the shared trigger and option list.

## Sort and location stay independent

`nearest` does not auto-select a radius. Choosing an order must never delete
results; "nearest + anywhere" (all items, closest first) is a supported
combination. Sort decides the order, `LocationSelect` decides which items
exist. Sort shows only a read-only hint naming the centre `nearest` uses; the
source is chosen in one place, the Location control, and its "measured from"
section appears only when something uses a centre (a radius, a pending radius,
or `nearest`).

## Requested vs applied

Controls label their trigger from what the server or resolver actually did,
and tick what the user asked for:

- `SortSelect` labels from `meta.sort_applied`. A `relevance` request with no
  anchor and no typed text degrades to `newest` server-side. When a response
  reports no order at all (`sort_applied` absent, an older search service) the
  trigger names no value. `relevanceAvailable` is a client-side prediction
  ("is there a query vector at all"); it cannot see whether signals-search
  could use the anchor (for example an unindexed profile, where the BFF retries
  anchor-less and reports `newest`). When the request was relevance and the
  response says otherwise, the relevance option is listed as unavailable with a
  reason, so the trigger and the tick never contradict each other and
  re-picking relevance is not a silent no-op.
- `LocationSourceSelect` labels from the effective source. `preferredSource`
  defaults to `profile` even when the profile has no location, and
  `useUserLocation` then resolves to `browser`; labelling from the preference
  would contradict the greyed-out "My profile" option.

## Unavailable options

`OptionSelect` lists an option that cannot be chosen with a reason, rather than
omitting or natively disabling it. It uses `aria-disabled` (not `disabled`) so
the option and its `aria-describedby` reason stay in the accessibility tree.
Popovers that can open over the maximized map (`fixed inset-0 z-[2000]` in
`map-container.tsx`) set `zIndex: 2100`, because `PopoverContent` portals to
`document.body` and would otherwise paint under that layer while holding focus.
