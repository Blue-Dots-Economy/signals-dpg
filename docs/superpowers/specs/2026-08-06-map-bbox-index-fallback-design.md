# Map bbox fallback when `item_search` is unpopulated — design

**Date:** 2026-08-06
**Status:** approved (brainstorm with Srivatsa)
**Branch:** `feat/map-bbox-index-fallback` (off `feature`)

## Problem

The map's viewport (bbox) filter is a hard `EXISTS` against the `item_search`
table's GiST-indexed `geo` column (`apps/api/src/utils/item_fetch_runtime.ts`,
bbox branch of `buildWhereClause`). `item_search` is a read-model maintained
solely by the signals-search ingestion worker.

In an environment where that worker is **not running** (local dev, per-domain
deploys without signals-search, or a data migration that inserted rows straight
into `items`), `item_search` is empty, every bbox `EXISTS` is false, and the
map silently shows **zero pins** — even though the affected items have valid
coordinates in `items.item_locations`. The list view is unaffected (its native
path never touches `item_search`), which makes the failure look map-specific
and confusing.

Observed concretely: migrated items landed in `items` with locations, no
signals-search worker in that environment, map empty.

## Decision

Add an automatic, per-request fallback inside `buildWhereClause`'s bbox branch:

1. **Probe** (only when bbox params are present):
   `SELECT EXISTS (SELECT 1 FROM item_search WHERE item_network = $1 AND item_domain = $2)`
   — an index-only lookup on the leading PK columns; sub-millisecond. No
   caching, no config flag.
2. **Probe true** → the existing GiST-gated `EXISTS` on `item_search.geo`,
   byte-for-byte unchanged. Healthy deployments keep the fast path.
3. **Probe false** → a jsonb bbox condition on the item's own locations,
   mirroring the shape of the existing radius branch:

   ```sql
   EXISTS (
     SELECT 1 FROM jsonb_array_elements(items.item_locations) loc
     WHERE (loc->>'lat')::float8 BETWEEN <min_lat> AND <max_lat>
       AND (loc->>'lng')::float8 BETWEEN <min_lng> AND <max_lng>
   )
   ```

   A bbox on lat/lng is a pure numeric range check — no `earth_distance`
   needed. Semantics match the GiST path's `ST_Intersects` recheck: "any of
   the item's locations inside the viewport".

### Alternatives considered

- **Config flag** (`MAP_GEO_SOURCE=items` on worker-less deploys): predictable
  and probe-free, but every environment must remember to set it — the silent
  blank-map trap remains for anyone who forgets. Rejected.
- **Per-item union** (always `item_search` OR jsonb): also covers a
  *partially stale* index, but adds jsonb-scan cost to every map pan in every
  healthy environment. Rejected as disproportionate.

## Scope and behavior notes

- **One file changes:** `apps/api/src/utils/item_fetch_runtime.ts`. No UI,
  route, schema, signals-search, or inter-instance changes.
- **Federation:** peers serve `markers_local` through the same
  `fetchLocalMarkers`/`buildWhereClause`, so the fallback applies per instance
  automatically.
- **Counts stay consistent:** `countLocalItems` and `fetchLocalMarkers` share
  `buildWhereClause`, so `meta.total` and the page flip paths together (the
  UI's zoom-band truncation logic sees coherent numbers).
- **Everything else unchanged for free:** `lifecycle_status = 'live'` is a
  separate items-side condition the markers route always forces; the
  degenerate-box → `sql\`false\`` guard stays; `capForZoom`/`MAP_FETCH_LIMIT`
  limits and offsets apply as today; distance ordering already reads
  `items.item_locations`.
- **Self-healing:** the moment the worker indexes the first row for that
  network+domain, the probe flips true and the indexed path takes over — no
  restart, no flag.
- **Accepted limitation:** the probe distinguishes *empty* vs *not empty*
  only. A partially lagging index (worker down for a while, some rows
  indexed) still trusts the index; the worker's ~60s reconciliation sweep is
  the recovery path for that, as today.
- **Scale envelope:** fallback environments hold < ~10k items per
  network+domain. The jsonb pass over a domain's live rows is a few
  milliseconds at that size. The probe runs per `buildWhereClause` call
  (count + fetch = twice per request); both are negligible, so no probe cache
  (YAGNI).

## Testing (TDD)

- **Unit (`buildWhereClause` / markers-shaped):**
  - bbox + empty `item_search` → SQL contains the jsonb condition, not the
    `item_search` join;
  - bbox + non-empty `item_search` → unchanged GiST condition;
  - degenerate/inverted box → `false` condition regardless of probe;
  - radius branch untouched by the probe (no probe call without bbox).
- **Integration (db + redis):** items with locations, `item_search` empty →
  markers inside the viewport returned, outside excluded, `meta.total`
  matches; insert an `item_search` row for the domain → index path governs
  again (an unindexed item disappears, proving the switch).

## Out of scope (possible follow-ups)

- A `meta`/UI signal that the map is running on the fallback (the results are
  correct, just computed the slow way — nothing to warn about at this scale).
- Covering partial index staleness (per-item union) or an expression index
  for large worker-less deployments.
- The related-but-separate silent-degradation observation for a *stale*
  index; tracked conceptually with the deferred re-geocode/backfill sweeps
  from #436's discussion.
