# UI map markers: fetch, hold and recount

Describes `apps/ui/src/hooks/use-map-markers.ts` and the helpers it uses in
`apps/ui/src/lib/map-viewport-snap.ts` and `apps/ui/src/lib/map-caps.ts`.

## One query per domain

The map fetches `/api/v1/network/item/markers` once per visible domain through
`useQueries`. Each query key (`queryKeys.markers`) carries the snapped bbox, a
bbox token, that domain's facet filters, the trimmed `q` and the `limit`, so any
change to what is requested produces a distinct cache entry. The key has no zoom
band.

Facets are routed per domain. The server silently drops a facet that is not a
declared, non-private field of the domain's schema, so sending the same filter
set to every domain would return the domains without that field unfiltered.
A domain that cannot honour every active facet is not queried at all
(`enabled: false`) and contributes no pins.

## Bbox versus radius

Both live map providers report `map.getBounds()` corners, so the map uses the
bbox path. The bbox is clamped first (`clampBbox`): a zoomed-out provider reports
bounds beyond +/-180 / +/-90, which the markers endpoint rejects with a 400.
Viewports built by hand with only center + radius (tests only) use the radius path and a coarse radius-bucket cache key instead; the
request still sends the unrounded radius.

## Hold or refetch

The request is the visible view padded by 25% per side (`expandBboxForFetch`).
`heldRef` records the last completed fetch: that padded bbox, whether it was
truncated, whether it was empty, and the marker cap it used. It is written only
in an effect after every active domain's query has settled on real answers
(never while loading or in error).

On each render the hook refetches, padding the current view again, when any of
these holds:

- there is no prior fetch;
- the cap changed;
- the held result was empty, since every later viewport is inside the padded
  bbox and an empty set could never be escaped;
- `shouldRefetch` says so: the held result was truncated, or the view has left
  the fetched area.

Otherwise the held bbox is reused: while the view stays inside the fetched area
and the last answer was complete and non-empty, the key is stable and the
provider re-clusters the held marker set locally.

Each domain's previous answer is kept while a viewport refetch loads, so pins do
not blink out. It is cleared when the filters or the search text change, and it
is not used when that domain's current request failed.

### Bbox token

A contained zoom-in can snap to the same grid cell as the held bbox, which would
leave the key unchanged and skip a needed refetch. `bboxTokenRef` is bumped once
per genuinely new raw bbox while the held result is truncated or empty, which
forces a new key. It is not bumped before the first fetch settles, so noisy
initial viewport reports still dedupe. The refs are written during render with
the compare-then-write pattern, which is safe under StrictMode's double render.

## Marker cap

The bbox path requests `capForZoom(zoom) + 1` markers. A domain is truncated when
its `meta.total` exceeds the cap; the extra one means a total exactly equal to
the cap still counts as complete. Truncation is ORed across domains and drives
both the refetch decision and the "N+ in this area" pill. The radius path keeps
the flat `MAP_FETCH_LIMIT`.

## Count what is on screen

The count is the number of fetched markers inside the visible box, not
`meta.total`, which describes the larger fetched area. For a capped answer that
count is a lower bound and the pill shows it as "N+", including when it is 0.

## Failures

`isError` is separate from an empty result, so the map does not claim an area is
empty when the request failed. A failed domain shows no markers rather than its
previous ones.
