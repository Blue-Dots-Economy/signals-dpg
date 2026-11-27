# UI browse totals: list count versus map count

Describes `apps/ui/src/hooks/use-browse-totals.ts`, which feeds the count in the
browse bar.

## Three quantities

1. Items matching the filters (what the list counts).
2. Of those, the ones inside the map viewport (what the map pill counts).
3. Of those, the ones with a coordinate at all.

The map pill states (2). The browse bar states (1), so switching between list and
map does not change the bar's number, and the hook reports the (1) minus (3) gap
as `notMappable` ("N not on the map").

## Requests

Two requests per selected domain, both `limit: 1` (a count, not a feed), cached
at the browse tier (90s) and only enabled when the caller needs them:

- `/discover` with no area, `sort: 'newest'`, gives (1). It must send exactly
  what the list feed sends, including the anchor, or the two counts disagree.
- `/markers` with a global bbox gives (3). A bbox is required: without one the
  markers total counts every matching item, coordinates or not, and the
  difference is always zero. The bbox is inset (+/-85 lat, +/-179 lng) because
  the exact +/-90/+/-180 envelope returned 0 rows; nothing real sits beyond 85
  degrees, which Web Mercator cannot render anyway.

Facets are routed per domain as in `useMapMarkers`: the server drops a facet the
domain does not declare, so an unsatisfiable domain is not counted.

## The anchor and `q`

With an anchor, signals-search treats the typed text as a filter; with none, the
text is only a ranking signal and the total is the whole candidate set. The
anchor is resolved per target domain (`anchorFor`) because signals-search 403s
when the anchor's domain has no interaction with the domain being counted.
Measured on the dev cluster, a specific shop name returned total 135 for `q`
alone and 1 for `q` plus an anchor.

The anchor is part of the query key because it changes the result, not only the
order.

## When the gap is withheld

`/markers` always narrows on `q` with its own substring match. `/discover`
narrows only when the anchor was applied. signals-search rejects an anchor it
cannot compare (for example a profile with only private fields, so no
embedding), and the BFF then retries without it and returns 200. The hook
therefore reads `meta.anchor_applied` from the response. When a query has text
and any domain's anchor was not applied, the two counts come from different
matchers and `notMappable` is reported as 0; `total` still stands.

`notMappable` is also clamped at 0, since the two counts come from separate
requests and a write between them could make the difference negative.

## What "not mappable" covers

Items with no coordinate, and items not yet in the `item_search` geo read-model
that the bbox predicate reads (indexing lag). Both are reported as one number
because the user-visible effect is the same.
