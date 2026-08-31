# List view: unbounded paginated fetch + a legible filter surface

**Date:** 2026-08-31
**Status:** design approved, not yet planned
**Supersedes:** #631 (one-line statement of the same fetch problem)
**Re-scopes:** #404 (folding facets into the search box)
**Builds on:** #203 (epic), #419 (list → `/discover` BFF), #394 (removed the "Near me" toggle)

## 1. Problem

A signed-out visitor who declines geolocation sees every live item in the
network. The moment a user signs in with a profile that has a location, the
same list view silently collapses to a 30 km radius, with no control to widen
it and no indication that a bound was applied beyond one sentence of prose
above the grid.

That is the opposite of the original requirement: **the list view must be able
to page through all items in the network in a defined order.** The map view
owns location-based discovery; the list view should not be location-bounded by
default.

Separately, the browse filter surface has grown four uncoordinated controls
(sidebar domain tab, panel domain multi-select, panel facet groups, top-bar
search) plus one invisible rule (counterpart-only domain scoping), with no
single place that answers "what is currently filtering this list, and what can
I change?".

### 1.1 Why the list is bounded — root cause

`signals-search` applies the spatial clause as a **hard `WHERE` predicate**,
not a ranking signal:

```
-- signals-search/src/db/search_query.ts:69-75
conds.push(sql`ST_DWithin(s.geo, ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)::geography, :distanceMeters)`)
```

Radius resolution: request `distanceMeters` → `SEARCH_DEFAULT_DISTANCE_METERS`
→ **30 000 m**. `bluedots-automation` sets no override, so 30 km is the live
value.

Signals-DPG's list view sends a location whenever one resolves, and — since
#394 removed the "Near me" toggle — has no path that omits it:

```ts
// apps/ui/src/lib/browse-discover.ts:37-47
return { relevance: true, ...(q ? { q } : {}), filters };  // relevance hardcoded true
```

```ts
// apps/ui/src/hooks/use-infinite-browse-items.ts:148-150
...(userLocation ? { item_latitude: userLocation.lat, item_longitude: userLocation.lng } : {})
```

`useUserLocation` resolves profile location first, else browser geolocation
(auto-requested when the profile has none). There is no hardcoded default
coordinate — the source can legitimately be `none`, which is precisely why the
signed-out case looks correct.

| Viewer | lat/lng sent | Candidate set |
| --- | --- | --- |
| Signed out, geolocation denied | no | whole network — correct |
| Signed out, geolocation granted | yes | 30 km |
| Signed in with a profile location | always | 30 km, no opt-out |

`browse-discover.ts:18-25` already documents this as intended-with-known-gap
and names "a search wider affordance" as an unbuilt follow-up. This design is
that follow-up.

**Pagination itself is not the defect.** `LIMIT/OFFSET` and a true
`count(*)` both work; the candidate set they page over is truncated.

### 1.2 Genuine pagination and ordering defects

- **P1 — no ORDER BY tiebreaker.** All three ranking paths (cosine, distance,
  `indexed_at DESC`) order without a unique final key
  (`search_query.ts:95-100`). `LIMIT/OFFSET` over tied rows duplicates and
  skips items across pages. Worst on the recency path, where a bulk index
  produces many identical `indexed_at` values. This is a live correctness bug.
- **P2 — rerank silently truncates paging.** `search_route.ts:103-127`
  over-fetches `topN` from offset 0, reorders, then slices. Any
  `offset >= topN` returns an empty page while `meta.total` still reports the
  full count. `RERANK_DEFAULT=false` and `RESULT_TOPN=50` today, so this is
  latent — and would break paging at 50 items the moment reranking is enabled.
- **P3 — ordering is implicit and unchangeable.** ORDER BY is inferred from
  which inputs happen to be present: cosine if an anchor or text query exists,
  else distance if spatial, else recency. The user cannot see or choose the
  order, and when an anchor is present distance is only ever a filter, never a
  sort.
- **P4 — recency sorts on an ingestion artifact.** The recency path uses
  `item_search.indexed_at`, so a re-index or backfill reshuffles the entire
  user-facing feed.
- **P5 — federation gaps (unchanged, restated).** `/discover` is
  single-instance; on the native fallback path `q` does not forward to peers.
  `meta.total` on that path sums Redis-cached per-instance counts and can
  overstate, which `use-infinite-browse-items.ts:194-203` compensates for with
  a short-page check.

### 1.3 Why the list still needs an *optional* area filter

The map cannot be the only location-aware view. `apps/ui/src/lib/map-caps.ts`
caps markers at 1000 clustered / 500 individual (env-tunable), surfacing an
"N+ in this area — zoom in" pill when `meta.total` exceeds the cap. In a dense
cell at maximum zoom there is no further zoom to escape to. The list view is
the escape hatch, and to serve that case it needs an **explicit, opt-in** area
constraint — never a default one.

### 1.4 Filter surface problems

Domain scoping is split across three controls plus one invisible rule:

1. Sidebar Browse tab — `selectedDomain` / `?domain=`, scopes list + map +
   header count.
2. `MapFiltersPanel`'s domain chip multi-select — `mapSelectedDomains`,
   applies **only** on the "All" tab, **client-side only**.
3. Invisible `computeVisibleDomains` scoping — a signed-in viewer only ever
   sees domains their own domain can initiate toward, overridable via `?as=`.

On top of that:

- The top-bar search box is a fourth filter surface, and behaves differently
  per view: semantic embedding match in the list, `/markers?q=` value match on
  the map.
- The facet panel is named `MapFiltersPanel` but has served both views since
  #394.
- There is **no applied-filters chip row and no clear-all**. `resolveListNote`
  prints one of five sentences about the anchor and radius, and says nothing
  about active facets or search text.
- #404 proposes **deleting** the panel and folding facets into the search box
  as `field:value` tokens — the opposite direction from making applied filters
  visible. The two tickets need reconciling, not parallel implementation.

## 2. Decisions

| # | Decision | Rationale |
| --- | --- | --- |
| D1 | List view sends **no spatial clause by default** | Restores the original requirement; makes signed-in and signed-out behave identically. Smallest change that fixes the reported bug. |
| D2 | Location enters only via an **explicit area filter** | Serves §1.3's dense-map escape hatch without reintroducing an invisible default bound. |
| D3 | Distance is **not** blended into the default ranking | Rejected the alternative of moving `ST_DWithin` into `ORDER BY` as a boost: it needs relevance re-tuning and a cosine/distance blend decision. `nearest` as an explicit sort covers the need. |
| D4 | Ordering becomes an **explicit `sort` on the wire** | Fixes P3 at the contract level rather than papering over it in the UI. |
| D5 | Recency sorts on `items.created_at`, not `item_search.indexed_at` | Fixes P4. Users mean "newest listing", not "most recently ingested row". |
| D6 | `viewport` area mode is the **circumscribed circle** of the map bounds | signals-search supports one `s_dwithin` Point clause and no bbox operator. Approximating avoids a new spatial op; the UI labels it approximate. |
| D7 | Keep counterpart-only domain scoping; **make it visible** | No product ask to open peer-to-peer browse. Allowing it would drop the anchor (signals-search 403s non-interacting pairs), fall back to `newest`, and require hiding Connect. |
| D8 | The "All" view stays a **client-merged paged union** | `/discover` takes exactly one `item_domain`. B2 unifies the *control*, not the fetch. Stated explicitly so nobody plans a server-side multi-domain filter that does not exist. |
| D9 | #404 is re-scoped to additive `field:value` typing | The panel stays. Token syntax is a convenience for typists, not a replacement surface on a low-literacy, mobile-first product. |

## 3. Design — A: fetch contract

### 3.1 Area becomes an explicit, opt-in parameter

`deriveBrowseParams` gains an `area` discriminated union:

```ts
type BrowseArea =
  | { mode: 'anywhere' }                                  // default
  | { mode: 'radius'; center: LatLng; meters: number }
  | { mode: 'viewport'; bounds: MapBounds };              // → circumscribed circle (D6)
```

- `anywhere` sends no `item_latitude` / `item_longitude` / `distance_meters`.
  The BFF then builds no spatial clause, and `meta.distance_meters` is absent —
  the existing `resolveListNote` already degrades correctly when it is.
- `radius` sends centre + metres explicitly.
- `viewport` converts bounds to centre + circumscribed radius in the UI, and
  the chip label states that it is approximate.

`home-page` stops unconditionally forwarding `browseCoords`; the resolved
viewer location becomes the *default centre offered* when the user picks
`radius`, not an implicit filter.

### 3.2 Explicit sort

New `sort` field on the discover body, forwarded into the search envelope:

| `sort` | Requires | signals-search ORDER BY |
| --- | --- | --- |
| `relevance` | anchor or `textSearch` | `embedding <=> :vec ASC` |
| `newest` | — | `i.created_at DESC` (D5) |
| `nearest` | a centre | `ST_Distance(...) ASC NULLS LAST`, **no radius bound** |

Default: `relevance` when an anchor is sent, else `newest`. `nearest` supplies
a centre for ordering *without* implying a `WHERE` clause — that separation is
new capability in signals-search and is the crux of "location may sort, but
must not truncate".

Requesting `relevance` with neither anchor nor text falls back to `newest`
rather than erroring; the response reports the sort actually applied so the UI
never claims an order it did not get.

**Where `nearest`'s centre comes from.** The centre is independent of the area
filter. With `area: 'anywhere'` and `sort: 'nearest'`, the resolved viewer
location (`useUserLocation`) is sent as an **ordering centre only** — a new
request field distinct from the area's filtering centre, so the candidate set
stays the whole network while the order is nearest-first. When an area *is*
selected, its centre doubles as the ordering centre. If no location resolves at
all, `nearest` is offered as disabled and a request for it falls back to
`newest`, reported as applied per the rule above.

### 3.3 Deterministic paging (P1)

Append `s.item_id` as the final key to **every** ORDER BY in
`search_query.ts`. Unique per row, so page boundaries stop drifting.

### 3.4 Rerank paging guard (P2)

When `willRerank && pagination.offset + pagination.limit > topN`, skip
reranking for that request and page natively from the requested offset.
Ranking quality degrades gracefully at depth instead of returning an empty
page under a full `meta.total`.

### 3.5 Native fallback

Keeps its current role (search-service outage → distance/recency ordering,
`source: 'native_fallback'`, `degraded: true`) and learns the same sorts:
`newest` → `created_at DESC`, `nearest` → distance ASC. Existing degraded
messaging is unchanged.

### 3.6 Out of scope

Federated ranked discover; forwarding `q` to peers on the fallback path;
bbox/polygon spatial operators; any cosine-plus-distance blended score.

## 4. Design — B: filter surface

### 4.1 Applied-filters chip bar

A persistent row above the results, rendering one removable chip per active
constraint — domain, each facet field/value group, search text, `sort` when
non-default, `area` when not `anywhere` — plus a clear-all. Shared by list and
map, since both read the same state. Chips are the read-out; the panel remains
the editor.

### 4.2 One domain control

Collapse the sidebar Browse tab and the panel's domain multi-select into a
single first-class domain facet, surfaced as a chip like any other. Per D8 the
underlying fetch is unchanged: one `/discover` call per domain, client-merged
for the "All" case.

### 4.3 Make counterpart-only scoping visible

The domain control lists every domain in the network and marks non-interacting
ones unavailable with a one-line reason. `computeVisibleDomains` and the
interaction matrix are untouched — only explained.

### 4.4 Rename `MapFiltersPanel` → `BrowseFiltersPanel`

It has served both views since #394. The name misleads every reader.

### 4.5 Sort selector

Sits with the chip bar, driving §3.2. When section A has not yet landed, it
renders disabled with a reason rather than silently absent.

### 4.6 Accessibility

Chips form a labelled group, each removable by keyboard, with `aria-pressed`
state and focus returned to the bar after removal. Existing
`pointer-coarse:min-h-11` touch targets are preserved.

## 5. Files affected

**Signals-DPG — API**
- `apps/api/src/routes/v1/network/item/discover.ts` — `sort` passthrough;
  spatial only when an area is requested; report the applied sort.
- `apps/api/src/services/signals_search_client.ts` — `sort` in the envelope;
  centre-without-radius for `nearest`.
- `packages/schemas/src/api/discover_schemas.ts` — `sort`, area fields.

**Signals-DPG — UI**
- `apps/ui/src/lib/browse-discover.ts` — `BrowseArea`, drop the hardcoded
  always-send-location behaviour.
- `apps/ui/src/hooks/use-infinite-browse-items.ts` — area + sort in the query
  key and request body.
- `apps/ui/src/pages/home-page.tsx` — stop forwarding `browseCoords`
  unconditionally; wire the chip bar and sort selector.
- `apps/ui/src/components/map/map-filters-panel.tsx` → rename; domain control
  unification.
- New: applied-filters chip bar component; sort selector.
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — chip, sort, area, and
  domain-unavailable copy.

**signals-search**
- `src/db/search_query.ts` — `item_id` tiebreaker; explicit sort; `created_at`
  recency; centre-for-ordering without a radius predicate.
- `src/api/schemas.ts` — `sort` in the envelope.
- `src/api/search_route.ts` — sort plumbing; rerank paging guard.

## 6. Testing

- **P1 regression:** seed rows with identical sort keys, page through with
  `limit` smaller than the tie group, assert the union of pages equals the full
  set with no duplicates. Fails before the tiebreaker.
- **Unbounded default:** a discover request with no area sends no spatial
  clause and returns rows beyond 30 km from the viewer's profile location.
- **Signed-in / signed-out parity:** identical result sets for the same
  network/domain/sort with no area selected.
- **Sort matrix:** each `sort` value produces the expected ORDER BY; a
  `relevance` request with no anchor and no text reports `newest` as applied.
- **`nearest` does not filter:** ordering by distance returns items outside the
  configured default radius.
- **Rerank guard:** with rerank enabled, `offset >= topN` returns real rows
  rather than an empty page.
- **UI:** chip bar renders one chip per active constraint and clear-all resets
  every one; removing the area chip re-queries unbounded; a non-interacting
  domain is listed as unavailable with its reason.

## 7. Summary

Two separable pieces of work. **A** makes the list view do what was asked
originally — page through the whole network in a sort the caller chooses — by
making location opt-in, making ordering explicit on the wire, and fixing two
real paging defects (`item_id` tiebreaker, rerank truncation guard). **B**
makes the resulting state legible: one chip bar showing every applied
constraint, one domain control instead of three, and the counterpart-only rule
explained rather than silently enforced.

## 8. Design — C: the card metric follows the ranking basis (#646)

### 8.1 Problem

Users conflate the list **order** with the **match score** on each card. Both
the badge and the modal show the same quantity — `1 - cosine_distance` between
two BGE-M3 embeddings — through three scales: `/v1/relevance` emits 0–100
(`relevance_route.ts:14`), the provider divides by 10
(`providers/signals_search/client.ts:11-14`), the `/discover` seed multiplies
by 10 (`use-match-score.ts`, `seedFromDiscoverScore`).

**The score is pure cosine. The API composes filters, never scores:**

- `score` = `(1 - (s.embedding <=> :vec))::float8`; nothing else contributes
- `distanceMeters` is a separate `ST_Distance` column, never folded in
- facets and `ST_DWithin` are `WHERE` predicates — membership, not position
- `ORDER BY` picks exactly one expression: cosine, else distance, else recency

So distance is **not** in the relevance %, and no weighted blend exists.

Two further defects: one badge carries two incomparable quantities
(profile↔item cosine with a profile, typed-text↔item cosine without, gated by
`VITE_FREETEXT_MATCH_SCORE_ENABLED`); and the Excellent/Good/Moderate/Low
bands over 0.85/0.70/0.50 are uncalibrated — BGE-M3 profile similarities
cluster in a narrow range, so the band reads as near-constant.

§3.2's explicit `sort` forces the decision: under `newest`/`nearest` an item
would be ordered by one quantity and badged with another.

### 8.2 Decision

The card's primary metric **is** the ranking basis, so metric and order can
never disagree:

| `sort` | Card metric |
| --- | --- |
| `relevance` | relevance %, labelled for its basis |
| `nearest` | distance (`distanceMeters`, already returned) |
| `newest` | posted date / age (`items.created_at`) |

A per-pair score is therefore shown only under `relevance`, where `/discover`
already returns it free — no N×`/v1/relevance` calls, which matters because it
shipped **1:1** (`source`, `target`), not the batched source×N of the original
design.

Also: one wire scale end to end (both conversion points deleted); the free-text
basis labelled rather than env-gated (`VITE_FREETEXT_MATCH_SCORE_ENABLED`
retired); and the dead dpg-scoring-era fields removed (`band`, `confidence`,
`reasoning`, `signals`, `prompt_version`, `model_provider`, `model` — never
populated by the `signals_search` provider).

**Design boundary:** this is correct *because* only one quantity ranks at a
time. A true composite relevance (cosine + proximity + facet bonus, weighted)
would supersede it and justify one unified relevance % across all sorts. Out of
scope, not rejected.

### 8.3 Explanation panel — honesty constraint

The panel may show: the sort in force and its metric; the `vectorize: true`
fields for the domain/item_type and their `vector_weight`; the viewer's and the
item's values for those fields side by side; and, separately, the constraints
that shaped the set but not the order.

It may **not** show a per-field breakdown of the score. The cosine is computed
over a single pooled embedding of the serialized `vectorize` fields
(`serializeItemText` repeats each line `vector_weight` times) and **cannot be
decomposed**. Any "what you have in common" display must be computed from
attribute overlap and labelled illustrative.

### 8.4 Future scope — user-tunable relevance

`vector_weight` is already a per-property knob (`vectorize_fields.ts`) applied
as literal line repetition at ingest. So user reweighting is buildable:
re-serialize **the viewer's own** profile with their chosen weights and embed it
on the fly (one TEI call) as the query vector — the item side needs no
re-indexing. Caveats: the result-cache key must include the weights;
per-request embedding gives up the stored-anchor-embedding shortcut. Depends on
#360 for declaring which fields are tunable.

## 9. Design — D: typed search is inert when an anchor is present (signals-search#148)

`search_route.ts:74` gates text embedding on `!message.intent.item?.id`, and
`search_query.ts` has **no text `WHERE` clause** — text only ever acts as the
query vector. With an anchor present, `textSearch` is consumed by nothing
(`willRerank` also needs it, but `RERANK_DEFAULT=false`). Signals-DPG sends `q`
and `anchor_item_id` together on every list query, and the anchor is present for
essentially all signed-in traffic.

**Effect:** typing in the list search box as a signed-in viewer with a profile
returns an identical set in an identical order. It works only on the *degraded*
native fallback, which value-matches `q`.

**Fix: text narrows, profile ranks.** Apply `textSearch` as an additional
value-match `WHERE` predicate ANDed with the existing conditions, alongside the
anchor query vector. Ranking is unchanged, so §8.2's relevance % still explains
the position. `normalized` already carries the full `intent`, so the cache key
is correct.

Rejected: vector blending (fuzzy, unmeasurable today), re-serializing anchor +
typed text into one embedding (costs an embed per query, still cannot narrow),
dropping the anchor when text is present (discards profile relevance exactly
when the user is most specific). Semantic blending is a follow-up.

**Open sub-question — which fields does text match?** The paths disagree today:
the native fallback uses declared non-private facet fields
(`resolveTextSearchFields` → `resolveAllowedFacetFields`), signals-search's
relevance uses `vectorize: true` fields. Recommendation: the `vectorize` set, so
text-narrowing and cosine-ranking describe the same content; the divergence is
noted for #360 to settle. `item_search` does not store the serialized text, so
the predicate runs against `i.item_state` via the existing `JOIN items i`.

## 10. P6 — the UI discards the server's ranking (confirmed live, folded into #644)

Reproduced on the deployed instance at `/home?view=list`: card badges read
**49%, 62%, 49%** top to bottom. Adding `&domain=provider` yields **62, 49, 49**.

`home-page.tsx:2396` re-sorts the fetched feed client-side by haversine
distance (`sortItemsByNearest`, defined at line 141), so the server's cosine
order arrives correctly and is discarded before render while each card still
displays the server's cosine score.

The sort sits inside the `selectedDomain === null` branch (line 2359), and
`selectedDomain` initialises from `searchParams.get('domain')` (line 657). It
therefore applies whenever no domain is explicitly selected — including for a
viewer with only **one** visible domain, where the sidebar offers no tab to set
it and the "Provider" header comes from `resolveHeaderDomain`'s
single-visible-domain fallback. That is the default landing state for a
signed-in seeker. The single-domain branch does not sort, which is why
`?domain=` fixes it.

Aggravating details: `nearestDistanceMeters` returns `Infinity` for an item with
no/empty `item_locations` (`lib/geo/distance.ts:53-55`), so location-less items
sort last; stored coordinates carry PII jitter, so printed addresses are not a
proxy for the sort key (the order looks non-monotonic even as a distance sort);
and it re-sorts the accumulated pages on each fetch, so positions reshuffle
during scroll.

**Shared trigger.** `sortItemsByNearest` short-circuits on
`if (!userLocation) return items` — the same condition that gates the 30 km
bound (§1.1). A resolved viewer location switches on both defects at once,
which is why the signed-out list looked correct on both counts and the two
symptoms always appeared together.

**Origin.** Pre-#419 the "All" view merged N independently-paged per-domain
feeds that were each server-ordered by distance; concatenating them interleaves
badly, so a client-side distance re-sort restored a globally coherent order.
Correct then, destructive now that the feeds are cosine-ranked.

### 10.1 Open design gap: what orders a multi-domain union?

Deleting `sortItemsByNearest` without answering this replaces a wrong order
with an arbitrary one:

- **Cosine is not comparable across domains.** Feeds anchored on the same
  profile but scored against different domains' embeddings do not share a
  scale, so interleaving by raw score is meaningless.
- Concatenating per domain is coherent within each block but buries the second
  domain.
- A true global ranking needs one server-side query across domains, which
  `/discover` cannot do — it takes exactly one `item_domain` (D8).

Must be decided as part of the §3.2 `sort` work. `nearest` makes a distance
merge legitimate again — but only when the user has asked for it.

**Blocks §8.2 (#646):** the card cannot honestly report the ranking basis while
the render silently changes the order.
