# My Actions — Filter & Sort Redesign (PII-aware, server-enforced)

- **Issue:** [Blue-Dots-Economy/signals-dpg#439](https://github.com/Blue-Dots-Economy/signals-dpg/issues/439)
- **Date:** 2026-08-04
- **Branch:** `feat/439-my-actions-filter-sort` (cut from `origin/feature`)
- **Status:** Design — pending review

---

## 1. Problem & goal

The **My Actions** page lists the connect/apply requests a user has **received** and **initiated**. Today it fetches up to 100 rows per tab and offers only a **client-side status filter** (All / Pending / Accepted / Rejected) and **no sorting** — server order is fixed `updated_at desc`.

As a user accumulates requests, they need to **filter and sort** — e.g. "show me only pending full-time-tutor requests within 10 km, ordered by match score." Because these are 1-1 profile-to-profile actions, a **relevance/match score** is meaningful and should be shown and sortable.

The hard constraint is **PII masking**: requester PII (name, mobile, email, full address) is revealed **only when the action reaches `accepted`** (`network.json` `reveals_pii_on_status: ["accepted"]`, plus the counterparty item must be `live`). Filtering, sorting, and display must respect this **server-side** — the API must never return, filter on, or sort on PII for non-accepted actions, even if a client sends such a param.

**Goal:** a full redesign of the My Actions page (UI + API) that adds server-enforced, PII-aware filtering and sorting to both tabs, with match score and distance surfaced on the cards.

---

## 2. Scope decisions (locked)

| # | Decision | Choice | Notes |
|---|----------|--------|-------|
| D1 | Which tabs | **Both tabs, received-first** | Received is the design lead (PII + match score matter most); Initiated gets the same controls minus PII-gated fields it never needs (an initiator already knows who they contacted). |
| D2 | Match score | **Include, reuse search scoring** | Compute per-counterparty relevance via the existing match-score service; show a badge + allow sort-by-relevance. Non-PII → available across all statuses. |
| D3 | Filter/sort placement | **Full server-side** | All filtering and sorting move into `GET /api/v1/action/fetch` via new query params; PII params rejected/ignored for non-accepted actions. |
| D4 | Non-PII profile facets | **Curated set via join** | API joins the counterparty `item_state` and exposes a schema-driven, non-private facet set (category, looking-for, area) using the existing `enum-filters` machinery. |
| D5 | Distance reference point | **Offer both, user toggles** | "My item" (item-to-item) or "My current location" (browser geolocation). Default = My item (no permission prompt). |
| D6 | PII filter/sort scope for accepted | **OPEN QUESTION** — see §9 | Which PII fields are filterable/sortable once accepted (name only vs name+area vs full set). Display of PII on accepted cards is in scope regardless. |
| D7 | Pagination UX | **Load-more / infinite scroll** | Server applies filter+sort across the whole dataset; UI loads pages incrementally. Per-tab and per-filter counts still shown. |

### UI layout (locked)
**Layout A — top toolbar + slide-over Filters sheet:**
- Sliding-pill tabs (Received / Initiated) with counts — kept from today.
- Status chips (All / Pending / Accepted / Rejected) + a **Sort** dropdown inline.
- A **Filters · N** button opening a right-side slide-over (reusing the map facet-panel component); active filters render as removable tokens with "Clear all".
- **Redesigned card** adds: match-score badge (◆ 8.4), distance (📍 3.2 km), and non-PII facet chips (category / looking-for). Name masked until accepted.
- Sort menu: Match score / Newest / Oldest / Distance / **Name A→Z (🔒 accepted only)**.
- Filters sheet has a dedicated **🔒 Requester PII** section, disabled with a banner for non-accepted, gated server-side.

---

## 3. Current-state map (what we build on)

**UI**
- `apps/ui/src/pages/my-actions-page.tsx` — page shell; tab state, eager fetch of both lists, status-update / bulk dialogs.
- `apps/ui/src/hooks/use-actions.ts` — `useActions` / `useInitiatedActions` / `useReceivedActions` (hardcoded `limit:100, offset:0`, no sort/filter); `usePendingActionsCount`; status mutations; 60s polling.
- `apps/ui/src/components/actions/action-list.tsx` — client-side status filter + tabs + grid.
- `apps/ui/src/components/actions/action-card.tsx` — the card.
- `apps/ui/src/lib/action-api.ts` — `FetchMyActionsQuery` (no sort field), `Action` type, `fetchMyActions()`.
- **Reuse:** `apps/ui/src/lib/enum-filters.ts` (schema-driven facet extraction, skips `private:true`), `apps/ui/src/components/map/map-filters-panel.tsx` (facet panel UI), `apps/ui/src/lib/geo/distance.ts` (`nearestDistanceMeters`) + `sortItemsByNearest` (home-page.tsx), `apps/ui/src/lib/match-score-api.ts` (`calculateMatchScore` → `POST /api/v1/match-score/calculate`).

**API**
- `apps/api/src/routes/v1/action/fetch_actions.ts` — `GET /api/v1/action/fetch`. Filters: `action_id/action_type/action_status(single, eq)/item_id`, `ownership_role`. Sort: fixed `desc(updated_at), desc(created_at)`. Pagination: `limit/offset` + `count(*)`. PII masking applied in the serialization layer (`resolveItemNames` + `displayName` gated on `reveals_pii_on_status` and `lifecycle_status==='live'`; fail-closed to masked).
- `packages/schemas/src/api/action_schemas.ts` — `FetchOwnedRecordsQuerySchemaBase` / `FetchOwnedActionsQuerySchema` (`limit` default 20/max 100, `offset`, `ownership_role`), `OwnedItemActionSchema`.
- `packages/database/src/drizzle_ref_tables/item_actions.ts` — `item_actions`, partitioned on `partition_network`; indexes `(source_owner, updated_at)` and `(target_owner, updated_at)`; **no index on `action_status`**; `action_status` is free-form `text`.
- `packages/schemas/src/network_workflow.ts` — `reveals_pii_on_status` + `getInteractionPiiRevealStatuses`.
- `apps/api/src/routes/v1/action/get_action_contact_details.ts` — the audited on-demand PII reveal endpoint (`revealed` + `reveal_blocked_reason`).

---

## 4. Architecture

### 4.1 API — `GET /api/v1/action/fetch` (extended)

Extend `FetchOwnedRecordsQuerySchemaBase` with **sort** and **filter** params; keep it backward compatible (all new params optional, existing defaults unchanged).

New query params (proposed):
- `sort` — enum: `match_score` | `recent` | `oldest` | `distance` | `name` *(name gated, see §9)*. Default `recent`.
- `sort_dir` — `asc` | `desc` (defaulted sensibly per `sort`).
- `action_status` — widen from single value to a **CSV / repeated** param (multi-select chips). Map UI groups (Pending=`created,pending`, Accepted=`accepted,completed`, Rejected=`rejected,cancelled`) to raw values.
- `action_type` — multi-select (connect / apply / …).
- `facet.<key>` — repeated non-PII facet filters resolved against the counterparty `item_state` (e.g. `facet.category=tutor`). Only **declared, non-`private`** fields accepted; unknown/private keys **dropped server-side** (never enumerable), mirroring the discover/markers rule.
- `distance_ref` — `my_item` | `my_location`; when `my_location`, client passes `origin_lat` / `origin_lng`.
- `max_distance_m` — optional distance filter.

**Sorting & filtering execution.** The counterparty profile fields and match score are **not on `item_actions`**. Two-stage approach:
1. **DB stage** — filter/sort on action-row columns only: `action_status`, `action_type`, `created_at`/`updated_at`, owner (partition-aware). Add an index to support status filtering + the chosen sort (see §4.3). Distance-by-`my_item` can also be computed from the row's stored locations.
2. **Enrichment stage** — for facet filters, match score, and `distance_ref=my_location`, join `items.item_state` (as `resolveItemNames` already does) and compute score/distance. To keep this bounded, enrichment runs over a **candidate window**; where a facet/score sort can't be pushed to SQL, document the window size and **`log()`/telemetry the truncation** rather than silently cap.

> **Design note (scale):** `fetch_actions` currently does **not** pass a partition key, so it scans the parent partition. This redesign should pass `partition_network` where available for pruning, and add the status index. Match-score sort over large result sets is the main scale risk — see §7 caching.

**PII enforcement (non-negotiable, server-side):**
- Reuse the existing per-row reveal resolution (`getInteractionPiiRevealStatuses` + `lifecycle_status==='live'`, fail-closed).
- Any `sort=name` or `facet.<pii-field>` / PII filter is **honored only for rows whose status is in `reveals_pii_on_status`**; for all other rows the PII value is treated as absent — never decrypted, never returned, never used as a sort/filter key. A request that sorts by a PII field returns non-accepted rows ordered by the fallback key with PII masked, and the response signals the applied vs requested sort.
- No PII leaks through counts, either: facet counts over PII fields exclude non-accepted rows.

**Response:** keep `{ meta: {total, limit, offset}, actions: [...] }`; add to `meta` the **applied** sort/filters (so the UI can reconcile when the server ignores a PII param) and optionally per-facet counts. Each action row gains optional `match_score` and `distance_m` (only when computed/allowed).

### 4.2 UI

- **`my-actions-page.tsx`** — own the filter/sort/pagination state (URL-synced via `?` params like home-page's `f_<key>`), pass to hooks. Keep both tabs; received-first defaults.
- **`use-actions.ts`** — thread new params into `FetchMyActionsQuery`; switch received/initiated hooks to **infinite query** (`useInfiniteQuery`) for load-more. React Query keys already namespace on the full query object (cache-safe).
- **New components:**
  - `actions/action-toolbar.tsx` — chips + Sort dropdown + Filters button + active-filter tokens.
  - `actions/action-filters-sheet.tsx` — slide-over; non-PII facets (schema-driven via `enum-filters`), distance ref toggle + range, and the disabled 🔒 PII section for non-accepted.
  - Extend `action-card.tsx` — match-score badge, distance, non-PII facet chips; keep masking behavior.
- **Reuse** the map facet-panel patterns rather than reinventing.
- **i18n** — all new labels via `t()` keys (add to `locales/*.json`).

### 4.3 Database

- Add index on `item_actions` to back multi-status filtering + default sort, e.g. `(target_item_owner, action_status, updated_at)` and the initiated mirror `(source_item_owner, action_status, updated_at)`. Migration under `apps/api/drizzle/`; regenerate `apps/api/db/postgres/schema.sql` via `pnpm schema:bundle`. Follow the migration-append rule in `.claude/rules/database-conventions.md`.
- No new columns on `item_actions` (match score & profile facets are derived/joined, not stored) — unless §7 caching decides to persist a score snapshot.

---

## 5. Data flow (received tab, "pending tutors ≤10km by match score")

1. UI state → query params: `ownership_role=received&action_status=created,pending&facet.category=tutor&distance_ref=my_item&max_distance_m=10000&sort=match_score`.
2. API auth → `target_item_owner = userId`; DB filters status + partition prune; returns candidate window ordered by `updated_at desc`.
3. Enrichment: join counterparty `item_state`; apply `facet.category`; compute distance (my_item) and drop >10km; compute match score per counterparty.
4. PII gate: pending rows keep name masked; no PII field used in sort/filter.
5. Sort by `match_score desc`; paginate; return rows with `match_score`, `distance_m`, masked names, and `meta.applied`.
6. UI renders cards; "load more" fetches next page with the same params.

---

## 6. Effort matrix (per decision — chosen path in **bold**)

Rough T-shirt sizing. **S** ≈ ≤1 dev-day · **M** ≈ 2–3 · **L** ≈ 4–6 · **XL** ≈ 7+. Estimates are indicative, not commitments.

### D1 — Tab scope
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Received only | **S–M** | Toolbar/sheet + server params on received path only. |
| **Both, received-first (chosen)** | **M** | Same machinery reused on Initiated; hide PII-only affordances there (initiator knows the counterparty). |
| Both, fully symmetric | M+ | Extra edge cases making Initiated identical incl. PII affordances it doesn't need. |

### D2 — Match score
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Defer | S | Ship without score; add later. |
| Show only, no sort | M | Per-card score fetch/badge, no server sort-by-score. |
| **Include + sort (chosen)** | **L** | Per-counterparty score via match-score service, caching, and score-aware sort over a candidate window (scale risk — §7). Heaviest single piece. |

### D3 — Filter/sort placement
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Hybrid (server for PII, client for rest) | M | Less API work; weak at scale/pagination; non-PII facets only cover the fetched page. |
| **Full server-side (chosen)** | **L** | New query params + index + enrichment + PII enforcement in the query path. Required by the acceptance criteria. |

### D4 — Non-PII profile facets
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Action-level fields only | S | Filter/sort on row columns (status/date/type/distance) — no profile join. |
| **Curated set via join (chosen)** | **L** | Join counterparty `item_state`, schema-driven facet derivation, enrichment-window handling. |

### D5 — Distance reference point
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Item-to-item only | S | Compute from stored row locations; no permission prompt. |
| My current location only | S–M | Browser geolocation + permission UX. |
| **Both, user toggles (chosen)** | **M** | Both code paths + toggle UI + geolocation permission + empty-state when denied. |

### D6 — PII filter/sort scope *(OPEN — see §9)*
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Name only (sort + search) | S–M | Decrypt name in query path for accepted rows only; alphabetical sort + name search. |
| Name + area/locality | M | Above + revealed area facet for accepted. |
| Full PII set filterable | L | Name/mobile/email/address all filter/sortable — heaviest, most sensitive, questionable value. |

### D7 — Pagination
| Option | Effort | What it entails |
|--------|--------|-----------------|
| Numbered pages | S | Offset pages; simpler; clunky on mobile + live updates. |
| **Load-more / infinite (chosen)** | **M** | `useInfiniteQuery`, cursor/offset paging, count reconciliation with live polling. |

---

## 7. Cross-cutting concerns

- **Match-score caching/cost.** Scoring N counterparties per fetch is the main cost. Options: batch the score service, cache per (anchor_item, counterparty) with a short TTL (align with the ~90s browse tier), and/or persist a score snapshot on the action row at perform-time. To resolve during planning.
- **Enrichment window / no silent caps.** Where facet/score sort can't be pushed to SQL, cap the candidate window and surface the cap in `meta` + telemetry.
- **Polling vs load-more.** Reconcile the existing 60s `refetchInterval` with infinite pagination (refetch first page, or move to invalidate-on-write + manual refresh).
- **Partition pruning.** Pass `partition_network` where available (currently missing) to avoid parent-partition scans as filtering/sorting load grows.
- **Retire / lifecycle.** Retired counterparties already mask/fail-closed; ensure facet/score enrichment also fails closed for non-`live` items.
- **Backward compatibility.** All new params optional; existing callers unaffected.
- **Testing.** API unit tests for each new param incl. PII-param rejection on non-accepted rows (the security-critical case); UI tests for toolbar/sheet/sort/infinite scroll; an integration test asserting no PII leaks via sort/filter/counts.

---

## 8. Acceptance criteria mapping (issue #439)

- [ ] Received list supports filtering + sorting → §4.1/§4.2 toolbar + sheet + server params.
- [ ] Non-PII fields filterable/sortable across all statuses → curated facets + status/date/type/distance/match-score (D4/D2/D5).
- [ ] PII fields filter/sort/visible **only** for accepted; masked otherwise → §4.1 PII enforcement + §9 open question on which PII fields.
- [ ] Server enforces masking (no leak via params, not UI-only) → §4.1, §7 tests.
- [ ] Sensible default ordering → default `sort=recent` (most recent first).

---

## 9. Open questions (to resolve before/at planning)

1. **PII filter/sort scope (D6).** Which PII fields become filterable/sortable once accepted — **name only** (recommended: alphabetical sort + name search), **name + area/locality**, or the **full set** (name/mobile/email/address)? This drives how much decryption enters the query path and the sensitivity/cost. *Display* of PII on accepted cards is in scope regardless; this question is only about **filter/sort dimensions.**
2. **Match-score strategy (§7).** Live per-fetch scoring vs cached vs snapshot-at-perform-time — affects scale and whether we add a stored column.
3. **Facet source of truth.** Confirm the curated non-PII facet set per network comes from the schema's declared non-`private` enum fields (via `enum-filters`), and whether any field needs an explicit "filterable on actions" marker (cf. bluedots-allusecase-schemas #6 / #280).
4. **Distance default & geolocation UX.** Confirm default reference = "My item" and the permission-denied fallback for "My location".

---

## 10. Out of scope / YAGNI

- Changing the PII **reveal** flow itself (the audited `contact-details` endpoint stays as-is).
- Saved filter presets / cross-session persistence beyond URL params.
- Free-text search across requirement snapshots (unless it falls out of the facet work cheaply).
- Full PII filter set (unless §9.1 chooses it).
