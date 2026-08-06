# My Actions — Per-Profile Filter & Sort Redesign (PII-aware, server-enforced)

- **Issue:** [Blue-Dots-Economy/signals-dpg#439](https://github.com/Blue-Dots-Economy/signals-dpg/issues/439)
- **Date:** 2026-08-04 · **Revised:** 2026-08-05 (post-review — v3)
- **Branch:** `feat/439-my-actions-filter-sort` (cut from `origin/feature`)
- **Status:** Design v3 — revised after review; pending final sign-off

> **What changed in v3 (after review):** match score is now **computed once at connect and stored on the action row** (not scored per-fetch); **distance and profile facets are read live via a join** (nothing denormalized — no `item_state` copy); **PII is dropped from filter/sort entirely** (kept only for display masking); **"my current location" distance is deferred** (item-to-item only); and the page gains a **per-profile selector** so the list, filters, and sort are scoped to one of the user's profiles at a time. Net schema change is **one nullable column** (`match_score`) + indexes.

---

## 1. Problem & goal

The **My Actions** page lists the connect/apply requests a user has **received** and **initiated**. Today it fetches up to 100 rows per tab (`use-actions.ts` hardcodes `limit:100, offset:0`), offers only a **client-side status filter**, has **no sorting** (fixed `updated_at desc`), and **mixes every profile the user owns into one list**. Because relevance and distance are inherently *item-to-item*, mixing profiles makes a "most relevant first" sort meaningless.

**Goal:** redesign My Actions (UI + API) so the user first **picks one of their profiles**, then filters and sorts *that profile's* received/initiated requests — with **match score** and **distance** surfaced on the cards, all enforced server-side, and PII masked until an action is accepted.

---

## 2. Scope decisions (locked)

| # | Decision | Choice | How (v3) |
|---|----------|--------|----------|
| D0 | **Per-profile scoping** | **Yes — one profile at a time (no "All")** | Reuse the shared `useActiveProfile` store + `PageShell` rail; scope the list via the existing `item_id` param. |
| D1 | Which tabs | **Both tabs, received-first** | Received + Initiated, each scoped to the selected profile. |
| D2 | Match score | **Compute at connect, store on the row** | Nullable `item_actions.match_score`, computed async on the write path; read as a plain column. No per-fetch scoring. |
| D3 | Filter/sort placement | **Full server-side, backward-compatible** | New optional params on `/action/fetch`; existing callers unaffected. |
| D4 | Non-PII profile facets | **Join at read (no denormalization)** | `items.item_state` is already loaded in the fetch; filter via `facet_guard`. No `item_state` copy on the action row. |
| D5 | Distance | **Item-to-item, live at read — sort only (no distance filter)** | Compute from both items' `item_locations` at read; no stored column, no geolocation, no range filter. |
| D6 | PII in filter/sort | **Dropped entirely** | PII (name/mobile/email/address) is not filterable/sortable. Masking still gates **display** (unchanged). Distance stays as a **sort** option only (jittered/stored coords, non-PII). |
| D7 | Pagination | **Load-more / infinite** | `useInfiniteQuery`; exact per-profile counts. |
| — | UI layout | **Layout A inside `PageShell`** | Left profile rail (live-only) + top toolbar (chips + Sort + Filters) + slide-over Filters sheet; redesigned card with score/distance/facet chips. |

---

## 3. Current-state map (exact anchors)

**Profile-selection infra (reuse — almost all of D0 exists):**
- `apps/ui/src/hooks/use-my-items.ts` — `useMyItems(network)`: the user's own items (`created_by_me:true`), **draft/live/paused, excludes retired**.
- `apps/ui/src/hooks/use-active-profile.ts` — `useActiveProfile(network, myItems)` → `{activeProfileId, setActiveProfile, activeItem}`; localStorage-backed, per-network, **the same store the map/discover anchor uses**.
- `apps/ui/src/lib/active-profile.ts` — `get/set/clearStoredActiveProfileId`. **Home/map persists here** (`home-page.tsx:587/1527/1661`, reads `548/582`), so cross-page selection sync is free.
- `apps/ui/src/components/layout/page-shell.tsx` — `PageShell` accepts `myItems` / `activeProfileId` / `onActiveProfileChange` props (lines 27-29); renders `AppSidebar`.
- `apps/ui/src/components/layout/sidebar.tsx` — `AppSidebar`: the profile rail (groups by domain, lifecycle chips, `ProfileRowActions`). `apps/ui/src/components/ui/sidebar.tsx` gives responsive behavior (persistent rail desktop → `Sheet` drawer mobile via `useIsMobile()`).

**My Actions (change target):**
- `apps/ui/src/pages/my-actions-page.tsx` — renders its **own** header/`main` (NOT `PageShell`); `activeTab` default `received`; eager fetch of both lists.
- `apps/ui/src/hooks/use-actions.ts` — `useActions(role)` builds `{ownership_role, limit:100, offset:0}`, **no `item_id`, no sort/filter**; `useInitiatedActions`/`useReceivedActions`; `usePendingActionsCount` (**global**, no `item_id`); 60s poll.
- `apps/ui/src/components/actions/action-list.tsx` — client-side status filter (`FILTER_STATUSES`), tabs, grid, bulk bar; **no sorting**.
- `apps/ui/src/components/actions/action-card.tsx` — the card; masking via `hasRealName`/`ProfileCardModal`.
- `apps/ui/src/lib/action-api.ts` — `FetchMyActionsQuery` (**`item_id?` already exists**, no sort); `fetchMyActions` **already forwards `item_id`** (line 432); `Action` type.

**API:**
- `apps/api/src/routes/v1/action/fetch_actions.ts` — `GET /action/fetch`. `conditions[]` (68-100): maps `item_id`+`ownership_role` → `source/target_item_id` and always ANDs the owner filter (**`item_id` not validated as owned — fails closed to empty**). Fixed `orderBy` (114); `count(*)`+paged select. PII masking via `resolveItemNames` (305, **already selects `items.item_state`** at 323) → `revealStatusesByAction` (151-175, fail-closed) → `displayName` (205, reveals only when `status ∈ reveals_pii_on_status && lifecycle_status==='live'`).
- `apps/api/src/routes/v1/network/action/perform_action.ts` — **`perform_network_action_handler`: the single write funnel** (self/proxied/inter-instance). Has `targetItemSnapshot` (always local) and `sourceItemSnapshot` (local only when source is on this instance; else `null`); both carry `item_state` + `item_locations`. Row insert at 238-269; consent in the same txn; notifications fire-and-forget after commit (357-385) — the pattern the async score compute mirrors.
- `apps/api/src/routes/v1/action/perform_action.ts` — the `/perform` (+ `/perform/bulk`) proxy; forwards to the network handler above.
- `apps/api/src/utils/facet_guard.ts` — `resolveAllowedFacetFields`/`resolveAllowedFacetFilters` (schema-driven, non-`private` allow-list; used by discover/markers).
- `apps/api/src/utils/match_score_client.ts` — `getMatchScoreClient().calculate({itemA,itemB})` → signals-search `/v1/relevance`. Input `MatchScoreItem = {item_state, item_latitude?, item_longitude?}` (`packages/match_score/src/match_score.types.ts:8`). Pairwise, no batch.
- `packages/database/src/drizzle_ref_tables/item_actions.ts` — `item_actions`: partitioned on `partition_network`; owner indexes `(owner, updated_at)`; **no `action_status` index, no score/location columns**.
- `packages/database/src/drizzle_ref_tables/items.ts` — `items.item_locations` is a **jsonb column** (line 28) — the single coordinate source (same one the map uses; there is no separate location table).
- `packages/schemas/src/api/action_schemas.ts` — `FetchOwnedRecordsQuerySchemaBase` (92-100) ← schema to extend; `OwnedItemActionSchema` (111).

---

## 4. Architecture — what & how

### 4.1 Per-profile scoping (D0) — the frame for everything

- **Selection:** wrap `MyActionsPage` in `PageShell` and drive the rail with `useActiveProfile(network, liveItems)`. Because the store is shared, **the profile selected in the map/home view is already selected here** (and vice versa). Selecting a profile here updates the same store.
- **Rail shows live-only:** pass `myItems.filter(i => i.lifecycle_status === 'live')` to `PageShell`. If the shared store points to a non-live profile (map left a paused/draft one selected), scope locally to the first live profile **without calling `setActiveProfile`** — so the shared selection is preserved for the map. If the user has **no live profile**, no bespoke screen is needed — the rail's existing **"+ Create Profile"** affordance (the `My Profile(s)` section of `AppSidebar`) covers it, and the list area shows the existing empty state. If exactly one profile, it's auto-selected.
- **Scoping the data:** thread `activeProfileId` into the action hooks as `item_id`. Server already maps `item_id`+`ownership_role` → `source_item_id` (initiated) / `target_item_id` (received). Add `item_id` to `actionKeys.list(...)` so per-profile caches don't collide.
- **Server hardening:** add an explicit "is `item_id` owned by the caller?" check in `fetch_actions` returning `403`/`FORBIDDEN_ITEM` instead of today's silent empty list (defense-in-depth; UI only ever sends an id from `myItems`).
- **Unambiguous reference point:** the selected profile *is* "my item", so distance and match-score comparisons across the list are apples-to-apples.

### 4.2 Match score at connect (D2)

- **Column:** add nullable `item_actions.match_score` (real/numeric).
- **Where + when:** in `perform_network_action_handler`, **after** the action row commits, **fire-and-forget** (mirroring `dispatchActionNotifications`): build `itemA`/`itemB` from the two snapshots' `item_state` + primary `item_locations`, call `getMatchScoreClient().calculate(...)`, then `UPDATE item_actions SET match_score = … WHERE partition_network/action_type/action_id`. Connect latency is unaffected; a brand-new request briefly shows no score.
- **Create-time only:** the score is computed **exactly once, at action create (connect)**, for **all interaction types**. `update_action_status` (accept / reject / cancel / complete) must **never** (re)compute or clear it — it's a create-time property of the pairing.
- **Degrade / caveats:** compute only when **both** snapshots are available (source is local — the single-instance norm). Cross-instance source, or a relevance-service error/timeout, leaves `match_score = null` (logged). Score is a **connect-time snapshot**; recompute-on-profile-edit is **out of scope** for v1.
- **Read:** My Actions reads the column directly; sort-by-score is a plain `ORDER BY match_score DESC NULLS LAST, updated_at DESC`.
- **Backfill:** one-off script over existing **open** (non-terminal) actions where both items are local+live, populating `match_score`. (§11.)
- **All perform paths covered:** single `/perform`, `/perform/bulk`, and aggregator/voice on-behalf all funnel through the write handler, so all get scored.

### 4.3 API — `GET /api/v1/action/fetch` (extended, backward-compatible)

Extend `FetchOwnedRecordsQuerySchemaBase` (all optional, safe defaults → existing callers unaffected):

```ts
const ActionSortKeySchema = z.enum(['recent','oldest','match_score','distance']); // NO 'name' (D6)
// widen the existing single-value filters to multi-select:
action_status: z.union([z.string(), z.array(z.string())]).optional().transform(toStringArray),
action_type:   z.union([z.string(), z.array(z.string())]).optional().transform(toStringArray),
sort:          ActionSortKeySchema.default('recent'),   // 'distance' = sort only
facets:        z.array(z.object({ field: z.string(), values: z.array(z.string()).min(1) })).optional(),
// NO max_distance_m — distance is a sort key only, not a filter (D5).
// item_id (already present) carries the selected profile.
```

**Handler pipeline:**

1. **Auth + ownership + profile scope** — `userId`; `ownership_role` owner filter; `item_id` scope (+ the new owned-by-caller check).
2. **SQL WHERE** — extend `conditions[]`: `action_status` → `inArray`, `action_type` → `inArray`, and add `partition_network` for partition pruning where derivable.
3. **Choose the read path:**
   - **Fast path (pure SQL)** when `sort ∈ {recent, oldest, match_score}` **and** no `facets` **and** no `max_distance_m`: `ORDER BY` (score uses `NULLS LAST`) + `LIMIT/OFFSET`; `count(*)` exact. (`match_score` is a column, so score sort needs no enrichment.)
   - **Enriched path** when a **facet filter or `sort=distance`** is present: load **all** rows matching the SQL WHERE (bounded — one profile's actions, further capped by the per-pair cap), batch-load both endpoints' `item_state` + `item_locations` (extend the existing `resolveItemNames` query to also select `item_locations`), then in memory: apply `facet_guard`-allow-listed facet filters against the counterparty `item_state`, and for `sort=distance` compute item-to-item distance via `nearestDistanceMeters` (multi-location → nearest pairwise; missing location → `null`, sorts last), sort, and slice `limit/offset`. `count` = filtered length.
4. **Display enrichment (always, page-sized):** compute `distance_m` and gather non-PII facet chips for the returned page from the already-loaded `item_state`/`item_locations`, regardless of path — so cards always show them even when not sorting/filtering by them.
5. **PII masking (unchanged):** existing `revealStatusesByAction` + `lifecycle_status==='live'` fail-closed gate governs displayed names. **No PII is used for filter/sort** anywhere, so no decryption enters the query path.
6. **Response:** `{ meta, actions }`; add `meta.applied` (echo of honoured sort/filters) + exact `meta.total`; add optional `match_score:number|null` and `distance_m:number|null` to `OwnedItemActionSchema`.

**Edge posture (repo convention):** unknown/private facet field → dropped (not 400); relevance-service state is irrelevant at read (score is a stored column); missing location → null distance, never an error.

> **Scale note:** because the list is scoped to **one profile** and bounded by the per-pair cap, the enriched path's "load all matching rows" is small — the old per-fetch scoring fan-out risk is gone entirely.

### 4.4 UI

> **Approved reference prototype:** [`2026-08-04-my-actions-prototype.html`](./2026-08-04-my-actions-prototype.html) — the signed-off clickable mock (desktop + mobile: profile rail/drawer, tabs, status chips, sort menu, filters slide-over, card layout, percentage match badge, "Not scored yet", masked names). **Implementation should match this.**

- **`my-actions-page.tsx`** — wrap in `PageShell`; own `{sort, statusChips, facets, maxDistance}` state, URL-synced (`?profile=`, `?status=`, `?sort=`, `?f_<key>=`, `?km=`) — `?profile` falls back to the shared store when absent. Feed `PageShell` the **live-only** `myItems`.
- **`use-actions.ts`** — accept `itemId` + the new params; thread into `FetchMyActionsQuery`; convert received/initiated to **`useInfiniteQuery`** (page = `offset`); add `item_id`/params to the query key. Keep the 60s refresh (refetch page 0) so async scores/new requests appear.
- **`action-api.ts`** — extend `FetchMyActionsQuery` (sort/facets/status[]/max_distance) and `Action` (`match_score?`, `distance_m?`); serialize arrays/facets like discover.
- **New `components/actions/action-toolbar.tsx`** — status chips (multi), Sort dropdown (Match score / Newest / Oldest / Distance — **no Name**), Filters button + active-filter tokens + Clear all.
- **New `components/actions/action-filters-sheet.tsx`** — slide-over (reuse `Sheet` + `map-filters-panel` patterns): Action type + schema-driven non-PII facets. The facets use the **same mechanism as the Browse/Map filters** — `getEnumFilterFieldsForDomains` derives them from the `network.json` `enum` / `array+items.enum` fields (excluding `private:true`), here scoped to the **selected profile's counterparty domain**. New schema fields become filters with **zero code change**. **No distance filter** (D5 — distance is sort-only) and **no PII section** (D6).
- **Responsive / mobile (first-class).** `PageShell`/`AppSidebar` already collapse the profile rail into a `Sheet` **drawer** on mobile (`useIsMobile()`), toggled from the top bar; add a compact **profile chip + "Switch"** control at the top of the list on mobile for quick re-scoping. Status chips / Sort / Filters wrap; the card grid goes **single-column**; the Filters slide-over is full-height and the sheet + drawer are ≥44px touch targets. Verified against a phone-width frame in the prototype.
- **`action-list.tsx`** — drop client-side status filtering; render the infinite list + load-more sentinel; keep bulk selection and the **existing per-tab empty state** ("Nothing here yet / Requests … will appear here").
- **`action-card.tsx`** — reuse the existing **`components/match-score/match-score-badge.tsx`** (`MatchScoreBadge`) so the score renders as a **percentage + band**, identical to the map/list cards (`domain-card`, `marker-popup-card`); it normalizes `score/10` and uses `formatScorePercentage`/`getMatchScoreBand` from `@/utils/match-score-cache`. Feed it the stored `match_score`; **hide the badge when null**. Add a distance line (km, one decimal, when `distance_m` present) and non-PII facet chips. Masking unchanged.
- **Badge:** `usePendingActionsCount` stays **global** for the nav badge (v1); per-profile counts in the rail are **deferred**.
- **i18n:** all new labels via `t()` in `locales/*.json` (en + hi).

### 4.5 Database

- **Column:** add nullable `match_score` to `item_actions` (edit `apps/api/db/postgres/schema/…`, then `pnpm db:generate:api`, then `pnpm schema:bundle`; **never hand-edit generated migrations**).
- **Indexes:** add `(target_item_owner, action_status, updated_at)` and `(source_item_owner, action_status, updated_at)` to back per-profile + multi-status filtering and recency sort.
- **No** location or facet columns (both read live).

---

## 5. Data flow (received tab, profile = "My Tutoring", "pending, looking_for = Maths, by match score")

1. UI: selected profile from the shared store → `?profile=<tutorItemId>&status=Pending&sort=match_score&f_looking_for=maths`.
2. `GET /action/fetch?ownership_role=received&item_id=<tutorItemId>&action_status=created&action_status=pending&sort=match_score&facets=[{field:looking_for,values:[maths]}]`.
3. API: owner + `target_item_id=<tutorItemId>` (+ owned-by-caller check); SQL WHERE `inArray(status,[created,pending])` + partition prune. A facet is present → **enriched path**: load the (small) matching set, batch-load both items' `item_state`+`item_locations`, apply the `facet_guard`-allow-listed `looking_for=maths` filter.
4. Sort by `match_score DESC NULLS LAST` (score already on each row); slice page 0; exact count.
5. PII: pending → names masked (no PII in filter/sort). Cards show the % match badge, distance, facet chips.
6. "Load more" → offset page 1, same params.

---

## 6. Effort matrix (per decision — chosen path in **bold**; v3)

**S** ≈ ≤1 dev-day · **M** ≈ 2–3 · **L** ≈ 4–6. Indicative.

### D0 — Per-profile scoping
| Option | Effort | Entails |
|--------|--------|---------|
| No scoping (today) | — | Mixed list; relevance sort meaningless. |
| **Reuse active-profile + PageShell (chosen)** | **S–M** | Wrap in `PageShell`, feed live-only `myItems`, thread `item_id`, query-key + owned-by-caller check. Rail/mobile/selection all already exist. |
| Bespoke rail + new selection state | M | Reinvents what `AppSidebar`/`useActiveProfile` already do; also breaks map↔actions sync. |

### D2 — Match score
| Option | Effort | Entails |
|--------|--------|---------|
| Per-fetch scoring (old v2) | L | Pairwise fan-out per list load; scale risk. **Rejected.** |
| **Store at connect, async (chosen)** | **M** | One nullable column; fire-and-forget compute on the write path; backfill script; degrade to null. Read is pure SQL. |
| Store at connect, synchronous | M | Same, but blocks connect on the relevance call. **Rejected (latency).** |

### D3 — Placement · **Full server-side (chosen), backward-compatible** — **M** (params + indexes; existing callers untouched).

### D4 — Non-PII facets
| Option | Effort | Entails |
|--------|--------|---------|
| Copy `item_state` onto the row | M+ | Heavy/duplicative/stale. **Rejected.** |
| Snapshot only curated facet fields | M | Tiny jsonb, pure-SQL — but still stale; unnecessary at this scale. |
| **Join at read (chosen)** | **S–M** | `item_state` already loaded; add `facet_guard` filter in memory over the bounded per-profile set. Live values, zero denormalization. |

### D5 — Distance
| Option | Effort | Entails |
|--------|--------|---------|
| Store `distance_m` at connect | S | Pure-SQL sort, but stale if either profile moves. |
| **Join at read, item-to-item, sort only (chosen)** | **S** | Extend the items load with `item_locations`; compute live for ordering. Always current; no filter control. |
| + "my current location" | +M | Geolocation/permission UX. **Deferred.** |

### D6 — PII in filter/sort · **Dropped (chosen)** — **S** (removes decryption from the query path; masking-for-display unchanged).

### D7 — Pagination · **Load-more/infinite (chosen)** — **M** (`useInfiniteQuery`, offset page, load-more; counts exact per profile).

---

## 7. Cross-cutting concerns & risks (v3)

- **Connect-time scoring load (new, minor).** A burst of connects → a burst of async `/v1/relevance` calls. It's off the request path and one-per-connect (not per-list-load), so far lighter than v2; still, cap concurrency / let failures no-op to null.
- **Score staleness (accepted).** `match_score` reflects the profiles at connect time. Recompute-on-edit is out of scope; documented, not hidden.
- **Enriched-path bounds.** Per-profile + per-pair-cap keeps "load all matching rows" small; still `log()` if a single profile's set ever exceeds a sane cap (no silent truncation).
- **Cross-instance source.** No source snapshot at write → `match_score` null for that row (single-instance is the target deployment). Distance/facets still work at read if the counterparty item is fetchable; otherwise null.
- **Partition pruning.** Add `partition_network` to the fetch WHERE where derivable.
- **Lifecycle/retire fail-closed.** Distance/facet enrichment fails closed (null) for non-live counterparties, matching the name-mask gate (#273/#347).
- **Map↔actions selection coupling.** Sharing the store means selecting a profile in one view changes the other. Intended; the live-only local fallback avoids clobbering the store when the selected profile isn't live.
- **Backward compatibility.** All new params optional; `usePendingActionsCount`/`useReceivedActionsByStatus`/aggregator peers unchanged.
- **Testing.**
  - *API unit* (`__tests__/fetch_actions.test.ts`): multi-status/type; enriched-path facet/distance filter+sort; `match_score NULLS LAST`; owned-by-caller `item_id` check (403 vs empty); no PII in filter/sort output.
  - *API unit* (`__tests__/perform_*`): async score compute updates the row; null on cross-instance/relevance-error; not blocking the 201.
  - *API integration* (db+redis): per-profile scoping + no-PII-leak end-to-end.
  - *UI*: rail live-only + shared-store sync (map→actions), toolbar/sort/tokens, filters sheet (no PII section), infinite scroll, URL round-trip incl. `?profile`.

---

## 8. Acceptance-criteria mapping (issue #439)

- [ ] Received list supports filtering + sorting → §4.3 + §4.4 (scoped per profile, §4.1).
- [ ] Non-PII fields filterable/sortable across all statuses → status/type/date + facets (D4) + distance (D5) + match_score (D2).
- [ ] PII fields filter/sort/visible **only** for accepted; masked otherwise → PII **removed** from filter/sort (stricter than asked); display masking unchanged (§4.3.5).
- [ ] Server enforces masking (no leak via params) → no PII in the query path at all (§4.3.5); tests in §7.
- [ ] Sensible default ordering → `sort` defaults to `recent`.

---

## 9. Review resolutions

**Resolved:**
- **Match-score scope** → computed for **all interaction types**, **once at create (connect)** only; never on accept/reject/cancel/complete (§4.2).
- **Score display** → reuse `MatchScoreBadge` (percentage + band, via `formatScorePercentage`/`getMatchScoreBand` in `@/utils/match-score-cache`) so cards match the map/list cards exactly.
- **Score freshness** → connect-time snapshot for v1; **no recompute on profile edit** — MUST be in the PR description (§12).
- **Facet source** → all declared non-`private` enum fields of the selected profile's counterparty schema (via `facet_guard`).
- **Distance** → **sort only, no filter** (D5).
- **PageShell chrome** → adopted (My Actions gains the standard TopBar + profile rail).

- **Null-score card** → show **"Not scored yet"** for v1. The on-demand **Compute** button is a **fast-follow** (display-only reuse of the discover `MatchScoreButton` → `/match-score/calculate` first; persisted-for-sort later).
- **Empty states** → **reuse existing**: the per-tab "Nothing here yet / Requests … will appear here" list state, and the sidebar's existing **"+ Create Profile"** affordance for users with no profile. No new "no live profile" screen or copy.

**Default:** distance shown in km to one decimal.

Design is **locked** — no open questions remain.

---

## 10. Out of scope / YAGNI

- "My current location" distance + geolocation (D5 deferral).
- Any PII field as a filter/sort dimension (D6).
- Recompute of `match_score` on profile edit; a signals-search batch relevance endpoint.
- Per-profile pending-count badges in the rail (nav badge stays global for v1).
- An "All profiles" aggregate view.
- Copying `item_state`/facets onto the action row.
- Migrating Home's divergent local active-profile copy onto the shared hook (both already read/write the same store, so sync works; the refactor is separate).

---

## 11. Suggested implementation phasing

1. **DB** — add `match_score` column + status indexes; migration; schema bundle.
2. **Write path** — async match-score compute + row `UPDATE` in `perform_network_action_handler`; backfill script for open actions.
3. **API fetch** — extend schema; multi-status/type + sort + partition prune + owned-by-caller check; fast path (incl. `match_score` sort) + load-more; `meta.applied`.
4. **API enrich** — extend the items load with `item_locations`; facet (`facet_guard`) + distance filter/sort over the bounded set; page-sized display enrichment.
5. **UI shell** — wrap in `PageShell`, live-only rail via `useActiveProfile`, `item_id` threading, `?profile` URL/store sync, query keys.
6. **UI controls** — toolbar, filters sheet (no PII), card redesign (score/distance/facets), infinite scroll, i18n.

Phases 1-3 already deliver per-profile scoping + status/type filter + recency/score sort (the core of the acceptance criteria); 4-6 add facets, distance, and the full UI.

---

## 12. PR-description notes (must include when the PR is raised)

Per the repo's authoring rule (root `CLAUDE.md`), the PR needs an **In Plain Terms** section. Beyond that, explicitly call out:

- **Match score is a connect-time snapshot** — it is computed once when the connection is made and **not recomputed** if either profile later edits its details. Recompute-on-edit is a deliberate v1 deferral, not an oversight (see §4.2 / §9).
- **Distance is item-to-item and computed live** ("my current location" is deferred).
- **PII is not filterable/sortable** — masking still governs display only.
- **New column** `item_actions.match_score` + status indexes + a **one-off backfill** for existing open actions.
- Any **cross-instance** action shows no score (single-instance is the target deployment).
