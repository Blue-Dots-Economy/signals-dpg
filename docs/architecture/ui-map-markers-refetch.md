# UI map markers: fetch, hold and recount

Describes `apps/ui/src/hooks/use-map-markers.ts` and the helpers it uses in
`apps/ui/src/lib/map-viewport-snap.ts` and `apps/ui/src/lib/map-caps.ts`.

## One query per domain

The map fetches `/api/v1/network/item/markers` once per visible domain through
`useQueries`. Each query key (`queryKeys.markers`) carries the snapped bbox, the
zoom band, a bbox token, that domain's facet filters, the trimmed `q` and the
`limit`, so any change to what is requested produces a distinct cache entry.

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

`heldRef` records the last completed fetch: its bbox, that bbox padded by 25%
(`padBbox`), whether it was truncated, whether it was empty, and its zoom band.
It is written only in an effect after every active domain's query has settled.

On each render the hook refetches at the current bbox when any of these holds:

- there is no prior fetch;
- the zoom band changed (clustered vs individual pins). The key already changes
  on a band change, so the bbox must advance too, or the new key would fetch
  the stale wide bbox;
- the held result was empty. A held empty set can never be escaped, since every
  later viewport is inside the padded bbox, so an empty result is always retried;
- `shouldRefetch` says so: the held result was truncated, or the new bbox is
  outside the padded one.

Otherwise the held bbox is reused. React Query only refetches on a key change,
so a stable key serves the held marker set and the provider re-clusters it
locally.

### Bbox token

A contained zoom-in can snap to the same grid cell as the held bbox, which would
leave the key unchanged and skip a needed refetch. `bboxTokenRef` is bumped once
per genuinely new raw bbox while the held result is truncated or empty, which
forces a new key. It is not bumped before the first fetch settles, so noisy
initial viewport reports still dedupe. The refs are written during render with
the compare-then-write pattern, which is safe under StrictMode's double render.

## Zoom-band cap

The bbox path requests `capForZoom(zoom) + 1` markers. A domain is truncated when
its `meta.total` exceeds the cap; the extra one means a total exactly equal to
the cap still counts as complete. Truncation is ORed across domains and drives
both the refetch decision and the "N+ in this area" pill. The radius path keeps
the flat `MAP_FETCH_LIMIT`.

## Count what is on screen

When a held, non-truncated result covers the visible bbox, the hook counts the
markers inside the visible bbox rather than reporting `meta.total`, which
describes the larger fetched area. When the visible bbox is wider than the
fetched one (a zoom-out before the next fetch lands), or the domain is
truncated, it reports the server total.

## Failures

`isError` is separate from an empty result, so the map does not claim an area is
empty when the request failed.
