# Native item-fetch filters

Describes `apps/api/src/utils/item_fetch_runtime.ts` (`buildWhereClause`, `buildDistanceOrderBy`), the Postgres path behind `/network/item/fetch`, `/markers` and the native discover fallback.

## Facet filters (`item_state`)

- A scalar value `v` is normalised to `[v]`; every facet then goes through one guarded path. There is no unguarded `item_state @> {...}` branch.
- The guard (`resolveAllowedFacetFields`) allows only fields declared in the domain's item-schema `properties` and not `private: true`. A field outside that set is dropped silently (logged at debug), never rejected with a 4xx, so found/not-found responses cannot be used to enumerate a private or undeclared field's values. It fails closed: an unknown network/domain or a config load error yields an empty allowed set.
- Each allowed facet becomes `(item_state ->> field = ANY(values) OR item_state -> field @> to_jsonb(value) OR ...)`:
  - `->>` text equality matches scalar string fields and is served by the per-field btree expression indexes (`items_item_state_*_idx`).
  - `->>` on an `array`-typed field yields the JSON text of the whole array (`["Full-time","Flexible"]`), which never equals a single value. The `@>` clause covers that: it is true when the stored array contains the value, and when a stored scalar equals it. It is served by the GIN index on `item_state`. One `@>` per value, OR'd, because `@>` with a multi-element array means "contains all".
  - Text equality is exact only for string values. A numeric or boolean facet would compare as text (`'true'`, `'42'`). Every configured facet is a string enum today.
- An explicit empty value set matches nothing; an absent field applies no restriction.

## Free-text `q`

`text_search.fields` is the server-resolved allowlist of non-private fields (`resolveTextSearchFields` in `utils/facet_guard.ts`), never client input. The match is `ILIKE` over `jsonb_each_text(item_state)` with `\`, `%`, `_` escaped so `q` is always a literal substring. An empty `fields` list makes the match unsatisfiable rather than matching everything. It is ANDed with any geo condition, so text search is viewport-scoped.

## Bounding box

- Radius (`item_latitude`/`item_longitude`/`radius_meters`) and bbox (`min_*`/`max_*`) are mutually exclusive (see `withGeoSearchRefinement` in `packages/schemas/src/api/item_schemas.ts`).
- An inverted or degenerate box returns an empty result, not an error, and is checked before any query.
- When `item_search` has at least one row for the network+domain (`hasSearchIndexRows`, an index-only EXISTS probe run per call), the filter joins `item_search.geo`:
  - `&&` against the envelope is the GiST-indexed pre-filter (`item_search_geo_gist`). It compares the envelope of a multi-location item, so it can false-positive when no single point is inside; `ST_Intersects` is the exact recheck.
  - Longitude is split into chunks of at most 120 degrees (`splitLngRange`), because `::geography` resolves a span wider than 180 degrees as the complement of the intended box. Chunks are OR'd.
  - The join requires `item_search.lifecycle_status = 'live'`.
- When `item_search` has no rows (no signals-search ingestion worker: local dev, worker-less deploys), the filter falls back to a numeric `BETWEEN` on `items.item_locations`. This branch has no lifecycle predicate; callers wanting live-only results must pass `lifecycle_filter: 'live_only'`. Once the worker indexes a row for the domain, the probe switches to the index path without a restart. The probe is empty-vs-not-empty on purpose: one indexed row means a worker exists, and its reconciliation sweep covers partial lag.

## Ordering

`buildDistanceOrderBy` is shared by `fetchLocalItems` and `fetchLocalMarkers` so the two cannot drift.

- `order_by: 'distance'` orders by the nearest location, then `created_at DESC`, `item_id ASC`.
- `order_by: 'created_at'` orders by recency even when coordinates are present, so an area filter can narrow the set without reordering it.
- Omitted `order_by` infers distance ordering from the presence of coordinates. `/network/item/fetch` and the markers path rely on that inference.
- A distance order without coordinates degrades to recency.

`fetchLocalItems` additionally puts `live` items first, so a live profile leads the owner's "My Profiles" list; for live-only discovery that key is a no-op.
