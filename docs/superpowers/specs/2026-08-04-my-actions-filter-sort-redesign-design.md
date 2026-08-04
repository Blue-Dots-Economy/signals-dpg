# My Actions — Filter & Sort Redesign (PII-aware, server-enforced)

- **Issue:** [Blue-Dots-Economy/signals-dpg#439](https://github.com/Blue-Dots-Economy/signals-dpg/issues/439)
- **Date:** 2026-08-04
- **Branch:** `feat/439-my-actions-filter-sort` (cut from `origin/feature`)
- **Status:** Design — pending review

---

## 1. Problem & goal

The **My Actions** page lists the connect/apply requests a user has **received** and **initiated**. Today it fetches up to 100 rows per tab (`use-actions.ts` hardcodes `limit:100, offset:0`) and offers only a **client-side status filter** (All / Pending / Accepted / Rejected in `action-list.tsx`) and **no sorting** — server order is fixed `updated_at desc, created_at desc` (`fetch_actions.ts:114`).

As a user accumulates requests they need to **filter and sort** — e.g. "show me only pending full-time-tutor requests within 10 km, ordered by match score." Because these are 1-1 profile-to-profile actions, a **relevance/match score** is meaningful and should be shown and sortable.

The hard constraint is **PII masking**: requester PII (name, mobile, email, full address) is revealed **only when the action reaches `accepted`** (`network.json` `reveals_pii_on_status: ["accepted"]`, plus the counterparty item must be `lifecycle_status === 'live'`). Filtering, sorting, and display must respect this **server-side** — the API must never return, filter on, or sort on PII for non-accepted actions, even if a client sends such a param.

**Goal:** a full redesign of the My Actions page (UI + API) that adds server-enforced, PII-aware filtering and sorting to both tabs, with match score and distance surfaced on the cards.

---

## 2. Scope decisions (locked)

| # | Decision | Choice | Notes |
|---|----------|--------|-------|
| D1 | Which tabs | **Both tabs, received-first** | Received is the design lead (PII + match score matter most); Initiated gets the same controls minus PII-gated fields it never needs (an initiator already knows who they contacted). |
| D2 | Match score | **Include, reuse search scoring** | Compute per-counterparty relevance via the existing match-score service; show a badge + allow sort-by-relevance. Non-PII → available across all statuses. |
| D3 | Filter/sort placement | **Full server-side** | All filtering and sorting move into `GET /api/v1/action/fetch` via new query params; PII params rejected/ignored for non-accepted actions. |
| D4 | Non-PII profile facets | **Curated set via join** | API joins the counterparty `item_state` and exposes a schema-driven, non-private facet set (category, looking-for, area) using the existing `facet_guard` machinery. |
| D5 | Distance reference point | **Offer both, user toggles** | "My item" (item-to-item) or "My current location" (browser geolocation). Default = My item (no permission prompt). |
| D6 | PII filter/sort scope for accepted | **OPEN QUESTION** — see §9 | Which PII fields are filterable/sortable once accepted. Display of PII on accepted cards is in scope regardless. |
| D7 | Pagination UX | **Load-more / infinite scroll** | Server applies filter+sort across the whole dataset; UI loads pages incrementally via `useInfiniteQuery`. Counts still shown. |
| — | UI layout | **Layout A** | Top toolbar (chips + Sort dropdown + Filters button) + right-side slide-over Filters sheet; redesigned card with match-score/distance/facet chips. |

---

## 3. Current-state map (exact anchors we build on)

**UI**
- `apps/ui/src/pages/my-actions-page.tsx` — page shell; `activeTab` state (default `received`, line 18), eager fetch of both lists, status-update / bulk dialogs.
- `apps/ui/src/hooks/use-actions.ts` — `useActions` (builds `FetchMyActionsQuery`, hardcoded `limit:100`, lines 64-68), `useInitiatedActions`, `useReceivedActions`, `usePendingActionsCount`, `useUpdateActionStatus(Bulk)`; `DEFAULT_POLLING_INTERVAL = 60000`.
- `apps/ui/src/components/actions/action-list.tsx` — client-side `FILTERS`/`FILTER_STATUSES` (lines 29-38), `useMemo` filter (79-83), tabs, grid, bulk bar. **No sorting.**
- `apps/ui/src/components/actions/action-card.tsx` — the card; masking already handled via `hasRealName`/`ProfileCardModal`.
- `apps/ui/src/lib/action-api.ts` — `FetchMyActionsQuery` (line 148, no sort), `Action` (line 161), `fetchMyActions()`.
- **Reuse:** `apps/ui/src/lib/enum-filters.ts` (`getEnumFilterFieldsForDomains`; skips `private:true` at line 80), `apps/ui/src/components/map/map-filters-panel.tsx` (facet-panel UI), `apps/ui/src/lib/geo/distance.ts` (`nearestDistanceMeters`) + `sortItemsByNearest` (home-page.tsx:109), `apps/ui/src/lib/match-score-api.ts` (`calculateMatchScore`, `itemToSnapshot`), home-page's URL-param filter convention (`?f_<key>=…`).

**API**
- `apps/api/src/routes/v1/action/fetch_actions.ts` — `GET /api/v1/action/fetch`. Builds `conditions[]` (lines 68-100), fixed `orderBy` (114), `count(*)` + paged `select` (105-116). PII: `resolveItemNames` (305) → `revealStatusesByAction` (151-175, fail-closed) → `displayName` (205, reveals only when `revealStatuses.includes(status) && lifecycle_status==='live'`) → memoised `unmask`/`decryptItemPrivate` (179-203). Response `meta + actions` with `ownership_roles` (247-250).
- `packages/schemas/src/api/action_schemas.ts` — **`FetchOwnedRecordsQuerySchemaBase` (lines 92-100)** ← the schema we extend. `FetchOwnedActionsQuerySchema` (102), `OwnedItemActionSchema` (111, extends `ItemActionSelectSchema`), `ActionOwnershipRoleSchema` (89).
- `apps/api/src/utils/facet_guard.ts` — **`resolveAllowedFacetFields(itemSchema)`, `resolveAllowedFacetFilters(...)`, `resolveTextSearchFields`, `buildWhereClause`** — the server-side, schema-driven, non-private facet allow-list + WHERE builder that `discover.ts` and `/markers` already use. This is the mechanism we mirror for D4.
- `apps/api/src/routes/v1/network/item/discover.ts` — the reference implementation of server-side facet filtering (`resolveAllowedFacetFilters(... body.filters)` at line 176) + signals-search-with-native-fallback. **Read before implementing the join.**
- `apps/api/src/utils/item_fetch_runtime.ts` — partition-pruning example (the "always filter on `item_network`+`item_domain`/`action_type`" contract) and its own `resolveAllowedFacetFields` at line 129.
- `apps/api/src/routes/v1/match_score/calculate_match_score.ts` + `apps/api/src/utils/match_score_client.ts` — `getMatchScoreClient().calculate({ itemA, itemB })` → signals-search `/v1/relevance`. **Pairwise only — no batch endpoint.** Body = `MatchScoreRequestSchema`, resp = `MatchScoreResponseSchema` (`packages/match_score`).
- `packages/database/src/drizzle_ref_tables/item_actions.ts` — `item_actions`, partitioned on `partition_network`; indexes `item_actions_source_owner_idx`/`_target_owner_idx` = `(owner, updated_at)` (56-63); **no `action_status` index**; `action_status` is free-form `text`.
- `packages/schemas/src/network_workflow.ts` — `reveals_pii_on_status` + `getInteractionPiiRevealStatuses` (452).

---

## 4. Architecture — what & how, per item

### 4.1 API contract — `GET /api/v1/action/fetch` (extended, backward-compatible)

**How:** extend `FetchOwnedRecordsQuerySchemaBase` in `packages/schemas/src/api/action_schemas.ts`. Every new field is optional with a safe default, so existing callers (`usePendingActionsCount`, `useReceivedActionsByStatus`, aggregator peers) are unaffected. Proposed shape:

```ts
// action_schemas.ts — additions to FetchOwnedRecordsQuerySchemaBase
const ActionSortKeySchema = z.enum([
  'recent',      // updated_at desc (default) — existing behaviour
  'oldest',      // updated_at asc
  'match_score', // relevance desc (enrichment)
  'distance',    // near→far (enrichment or row-locations)
  'name',        // PII — gated; see §9
]);

// action_status widened from single value → repeatable/CSV multi-select:
action_status: z.union([z.string(), z.array(z.string())]).optional()
  .transform(toStringArray),          // ['created','pending']
action_type:   z.union([z.string(), z.array(z.string())]).optional()
  .transform(toStringArray),
sort:      ActionSortKeySchema.default('recent'),
// Non-PII facets on the COUNTERPARTY item_state. Same wire shape discover uses
// (array of {field, values}); server allow-lists via facet_guard.
facets:    z.array(z.object({ field: z.string(), values: z.array(z.string()).min(1) })).optional(),
// Distance
distance_ref:   z.enum(['my_item', 'my_location']).default('my_item'),
origin_lat:     z.coerce.number().optional(),   // required iff distance_ref==='my_location'
origin_lng:     z.coerce.number().optional(),
max_distance_m: z.coerce.number().int().positive().optional(),
```

**Handler pipeline** (`fetch_actions_handler`), in order:

1. **Auth + ownership** — unchanged (`userId`, `ownership_role` → `source/target_item_owner` conditions).
2. **DB-stage WHERE** — extend the existing `conditions[]`:
   - `action_status` → `inArray(item_actions.action_status, statuses)` (replaces the single `eq` at line 72).
   - `action_type` → `inArray(...)`.
   - Add `partition_network` to the WHERE when derivable (currently absent) so the planner prunes — per `.claude/rules/database-conventions.md`.
3. **DB-stage ORDER + candidate window** — for `recent`/`oldest`, order in SQL (backed by the new index, §4.3) and paginate directly. For `match_score`/`distance`/facet-filtered queries that can't be fully expressed in SQL, fetch a bounded **candidate window** (see §7) ordered by `updated_at desc`, then finish in the enrichment stage.
4. **Enrichment stage** (only when facets / score / `distance_ref==='my_location'` are requested) — reuse `resolveItemNames`'s existing batch `items` query (extend its `select` to also return `item_state` + `item_locations`, already partly selected at fetch_actions.ts:317-328):
   - **Facets (D4):** resolve the counterparty item's `item_type` schema, call `resolveAllowedFacetFields`/`resolveAllowedFacetFilters` (`facet_guard.ts`) to **drop any non-declared or `private:true` field server-side**, then apply the allow-listed facet values against `item_state`. This is exactly discover's guard — a private/undeclared facet is silently dropped, never enumerable.
   - **Distance:** `my_item` → distance between the two rows' `*_item_locations`; `my_location` → distance from `(origin_lat,origin_lng)` to the counterparty location. Reuse `nearestDistanceMeters`. Apply `max_distance_m` filter; attach `distance_m` to the row.
   - **Match score (D2):** for each distinct counterparty item, call `getMatchScoreClient().calculate({ itemA: myItemSnapshot, itemB: counterpartySnapshot })`. **Pairwise → one call per counterparty**, so this stage must be **concurrency-limited + cached** (see §7). Attach `match_score` to the row.
5. **PII gate (unchanged posture, extended to sort/filter):** the existing `revealStatusesByAction` + `lifecycle_status==='live'` gate (fail-closed) is the single source of truth. Any `sort==='name'` or PII-referencing facet is honoured **only for rows whose status ∈ reveals_pii_on_status**; for every other row the PII value is treated as absent — never decrypted, never returned, never used as a sort/filter key. A `sort=name` request orders non-accepted rows by the fallback key (`recent`) with names masked.
6. **Sort + paginate** — apply the requested `sort` over the enriched window; slice `limit`/`offset`.
7. **Response** — keep `{ meta, actions }`; **add** to `meta`: `applied` (the sort/filters actually honoured, so the UI can reconcile when a PII param was ignored) and optional per-facet `counts`; **add** optional `match_score:number|null` and `distance_m:number|null` to `OwnedItemActionSchema`. Document any candidate-window truncation in `meta` + `request.log`.

**Error/edge posture** (per repo convention): unknown facet field → dropped (not 400); PII sort on non-accepted → downgraded to `recent` for those rows and reflected in `meta.applied`; match-score service down → `match_score:null` + fall back to `recent` ordering (mirror discover's degrade-don't-5xx behaviour).

### 4.2 UI — what & how, per component

- **`my-actions-page.tsx`** — becomes the state owner for `{ statusChips, sort, facets, distance_ref, origin, maxDistance }`, synced to the URL (`?status=`, `?sort=`, `?f_<key>=`, `?dist=`, `?km=`) following home-page's `f_<key>` convention so views are shareable/back-button-safe. Passes state into the hooks.
- **`use-actions.ts`** — thread the new params into `FetchMyActionsQuery`; convert `useReceivedActions`/`useInitiatedActions` to **`useInfiniteQuery`** (page param = `offset`), exposing `fetchNextPage`/`hasNextPage`. Keys already namespace on the full query object, so filtered/sorted views are cache-isolated. Reconcile the 60s poll: refetch page 0 only, or switch to invalidate-on-write + a manual refresh button (keep the existing Refresh control).
- **`action-api.ts`** — extend `FetchMyActionsQuery` (sort/facets/distance/status[]) and `Action` (`match_score?`, `distance_m?`); update `fetchMyActions` to serialize arrays/facets like discover does.
- **New `components/actions/action-toolbar.tsx`** — status chips (multi-select), Sort `<DropdownMenu>` (Match score / Newest / Oldest / Distance / Name🔒), a **Filters · N** button (opens the sheet), and active-filter tokens with "Clear all". Pure presentational + callbacks; no fetching.
- **New `components/actions/action-filters-sheet.tsx`** — right-side slide-over (reuse the app's `Sheet`/`Dialog` primitive + `map-filters-panel.tsx` patterns). Sections: Action type, schema-driven non-PII facets (from `getEnumFilterFieldsForDomains` over the served domains), Distance (reference-point toggle `my_item`/`my_location` + range; requests geolocation only when the user picks `my_location`, with a permission-denied fallback message), and a **disabled 🔒 Requester PII** section with the banner "Available only for accepted requests — enforced by the server." (enabled only when the active status filter is Accepted-only, and even then the server is the real gate).
- **`action-list.tsx`** — drop the client-side `FILTER_STATUSES` `useMemo` (now server-driven); render the infinite list + a load-more sentinel / button; keep the bulk-selection machinery.
- **`action-card.tsx`** — add a match-score badge (`◆ {score}`), a distance line (`📍 {km} away` when `distance_m` present), and non-PII facet chips derived from the counterparty `item_state` (category / looking-for). Name masking unchanged.
- **i18n** — every new label via `t()` keys added to `apps/ui/src/locales/*.json` (en + hi at minimum, per the enabled-languages default).

### 4.3 Database

- **How:** edit the declarative schema in `apps/api/db/postgres/schema/` for `item_actions`, then `pnpm db:generate:api` (generated migration — **do not hand-edit**, per `.claude/rules/database-conventions.md` + `apps/api/drizzle/README.md`), then `pnpm schema:bundle` to refresh `schema.sql`.
- **Indexes:** add composite indexes to back multi-status filtering + default recency sort on both owner paths:
  - `(target_item_owner, action_status, updated_at desc)`
  - `(source_item_owner, action_status, updated_at desc)`
  These supersede reliance on the current `(owner, updated_at)` for filtered queries. (Partitioned table — indexes are created per-partition by the existing machinery.)
- **No new columns** for score/distance (derived/joined at read time) — *unless* §7 chooses the snapshot-at-perform-time option for match score, in which case add a nullable `match_score` column populated in `perform_action`.

---

## 5. Data flow (worked example — received tab, "pending tutors ≤10 km by match score")

1. UI state → `ownership_role=received&status=Pending&sort=match_score&f_category=tutor&dist=my_item&km=10`.
2. `fetchMyActions` → `GET /action/fetch?ownership_role=received&action_status=created&action_status=pending&sort=match_score&facets=[{category:[tutor]}]&distance_ref=my_item&max_distance_m=10000`.
3. API: ownership → `target_item_owner=userId`; DB WHERE `inArray(action_status,[created,pending])` + partition prune; candidate window ordered `updated_at desc`.
4. Enrichment: batch-load counterparty items; `facet_guard` allow-lists `category` (declared, non-private) and applies `tutor`; compute item-to-item distance, drop >10 km; compute match score per counterparty (concurrency-limited, cached).
5. PII gate: pending rows → names masked; no PII in sort/filter.
6. Sort by `match_score desc`; slice page 0; respond with `match_score`/`distance_m`, masked names, `meta.applied`.
7. UI renders cards; "load more" → offset page 1, same params.

---

## 6. Effort matrix (per decision — chosen path in **bold**)

Rough T-shirt sizing. **S** ≈ ≤1 dev-day · **M** ≈ 2–3 · **L** ≈ 4–6 · **XL** ≈ 7+. Indicative, not commitments.

### D1 — Tab scope
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Received only | S–M | Toolbar/sheet + server params on received path only; Initiated untouched. |
| **Both, received-first (chosen)** | **M** | Same machinery reused on Initiated; hide PII-only affordances there. Extra: per-tab default sort + count wiring. |
| Both, fully symmetric | M+ | Also give Initiated PII affordances it doesn't need — extra edge cases for no user value. |

### D2 — Match score
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Defer | S | Ship without score; add later. No score plumbing. |
| Show only, no sort | M | Per-card score fetch + badge; no server sort — score computed client-side per visible card, cache in React Query. |
| **Include + sort (chosen)** | **L** | Server-side pairwise `calculate` per counterparty (no batch), concurrency-limit + cache, score-aware sort over a candidate window, degrade-to-`recent` on outage. Scale risk (§7). Heaviest single piece. |

### D3 — Filter/sort placement
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Hybrid (server for PII, client for rest) | M | Non-PII facets applied only over the fetched page; weak once pagination/large lists kick in; two filter code paths. |
| **Full server-side (chosen)** | **L** | New query params + indexes + enrichment stage + PII enforcement in the query path. Required by the acceptance criteria; reuses `facet_guard`. |

### D4 — Non-PII profile facets
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Action-level fields only | S | Filter/sort on row columns (status/date/type/distance) — no `items` join, no enrichment. |
| **Curated set via join (chosen)** | **L** | Extend the existing `resolveItemNames` `items` query to carry `item_state`; apply `facet_guard`; schema-driven facet UI. Reuses discover's guard so the security surface is already-proven. |

### D5 — Distance reference point
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Item-to-item only | S | Compute from the two rows' stored `*_item_locations`; no permission prompt, no origin params. |
| My current location only | S–M | Browser geolocation + `origin_lat/lng` params + permission UX. |
| **Both, user toggles (chosen)** | **M** | Both code paths + toggle UI + geolocation permission + denied-fallback empty state + `distance_ref` param branching. |

### D6 — PII filter/sort scope *(OPEN — see §9)*
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Name only (sort + search) | S–M | Decrypt name in query path for accepted rows only (the `unmask` path already exists); alphabetical sort + name `contains`. |
| Name + area/locality | M | Above + revealed-area facet for accepted (needs revealed-location handling, jitter-aware). |
| Full PII set filterable | L | Name/mobile/email/address all filter/sortable — most decryption in the hot path, largest audit/sensitivity surface, low real-world value. |

### D7 — Pagination
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Numbered pages | S | Offset pages; simplest; clunky on mobile + with live polling. |
| **Load-more / infinite (chosen)** | **M** | `useInfiniteQuery`, offset page param, load-more sentinel, count reconciliation with the 60s poll. |

---

## 7. Cross-cutting concerns & risks

- **Match-score cost (primary risk).** The client is **pairwise (`calculate({itemA,itemB})`), no batch** — N counterparties = N `/v1/relevance` calls. Mitigations to decide in planning (§9.2): (a) concurrency-limited fan-out per request (e.g. p-limit), (b) cache per `(myItemId, counterpartyItemId)` with a short TTL aligned to the ~90s browse tier — the score is stable between profile edits, (c) **snapshot the score onto `item_actions` at perform-time** (adds a nullable column, removes read-time cost, but can go stale on profile edits). Recommendation: (b) + concurrency limit for v1; consider (c) if latency is unacceptable.
- **Enrichment window / no silent caps.** When a sort/filter can't be pushed to SQL (score, some facets), the handler operates over a bounded candidate window. The window size must be explicit, and any truncation surfaced in `meta` + `request.log` — never silently cap (a truncated list must not read as "complete").
- **Partition pruning.** `fetch_actions` currently omits `partition_network`, scanning the parent. Add it to the WHERE where derivable; this matters once filtered/sorted load grows.
- **Polling vs load-more.** Reconcile the 60s `refetchInterval` with `useInfiniteQuery` (refetch page 0, or move to invalidate-on-write + manual Refresh).
- **Lifecycle/retire fail-closed.** Enrichment (facets/score/distance) must also fail closed for non-`live` counterparties, consistent with the existing name-mask gate (#273/#347).
- **Backward compatibility.** All new params optional; `usePendingActionsCount`, `useReceivedActionsByStatus`, and aggregator peers keep working unchanged.
- **Testing.**
  - *API unit* (`__tests__/fetch_actions.test.ts`): each new param; **security-critical** — assert a `sort=name` / PII-facet request returns non-accepted rows masked and unsorted-by-PII; assert unknown/private facet fields are dropped; assert score-service outage degrades to `recent` with `match_score:null`.
  - *API integration* (`*.integration.test.ts`, db+redis): end-to-end no-PII-leak across filter/sort/counts.
  - *UI*: toolbar chip/sort/token behaviour, filters-sheet PII-section disabled state, infinite scroll, URL-param round-trip.

---

## 8. Acceptance-criteria mapping (issue #439)

- [ ] Received list supports filtering + sorting → §4.1 params + §4.2 toolbar/sheet.
- [ ] Non-PII fields filterable/sortable across all statuses → D4 facets (via `facet_guard`) + status/date/type/distance/match-score.
- [ ] PII fields filter/sort/visible **only** for accepted; masked otherwise → §4.1 step 5 + §9.1.
- [ ] Server enforces masking (no leak via params, not UI-only) → §4.1 step 5, §7 tests.
- [ ] Sensible default ordering → `sort` defaults to `recent` (most recent first).

---

## 9. Open questions (resolve before/at planning)

1. **PII filter/sort scope (D6).** Which PII fields become filterable/sortable once accepted — **name only** (recommended: alphabetical sort + name `contains`, reuses the existing `unmask` path), **name + area/locality**, or the **full set**? Drives how much decryption enters the hot query path. *Display* of PII on accepted cards is in scope regardless; this is only about **filter/sort dimensions.**
2. **Match-score strategy (§7).** Live-cached per-fetch vs snapshot-at-perform-time (new nullable column)? Affects scale + schema.
3. **Facet source of truth.** Confirm the non-PII facet set comes from declared non-`private` enum fields via `facet_guard`/`enum-filters` (as discover does), and whether actions need an explicit "filterable on actions" marker (cf. bluedots-allusecase-schemas #6 / #280, and #360 for schema-driven search/filter declaration).
4. **Distance default & geolocation UX.** Confirm default `distance_ref = my_item` and the permission-denied fallback for `my_location`.
5. **Match-score for masked profiles.** Confirm it's acceptable to compute/show a relevance score for a *pending* (masked) counterparty — the score is derived from non-PII `item_state`, so this should be fine, but confirm it isn't considered an information leak.

---

## 10. Out of scope / YAGNI

- Changing the PII **reveal** flow itself (the audited `contact-details` endpoint stays as-is).
- Saved filter presets / cross-session persistence beyond URL params.
- Free-text search across requirement snapshots (unless it falls out of the facet work cheaply).
- A batch match-score endpoint in signals-search (would help cost, but is a separate cross-repo change — note as a follow-up if v1 latency demands it).
- Full PII filter set (unless §9.1 chooses it).

---

## 11. Suggested implementation phasing (for the plan)

1. **Schema + DB** — extend `FetchOwnedRecordsQuerySchemaBase`; add indexes + migration; regen schema bundle.
2. **API DB-stage** — multi-status/type filter, sort (`recent`/`oldest`), partition prune, load-more; response `meta.applied`. (Ships useful filtering/sorting on its own.)
3. **API enrichment** — facets via `facet_guard` + item_state join; distance (both refs); `distance_m`/facet counts.
4. **API match score** — concurrency-limited + cached pairwise scoring; `match_score`; degrade-to-`recent`.
5. **API PII enforcement + tests** — name sort/filter per §9.1 decision; the no-leak test suite.
6. **UI** — toolbar, filters sheet, card redesign, infinite scroll, URL sync, i18n.

Each phase is independently reviewable; 1–2 alone already satisfy the "default ordering + status/type filter" part of the acceptance criteria.
