# Signals UI — data-fetching at scale + relevance — design

**Epic:** [#203](https://github.com/Blue-Dots-Economy/signals-dpg/issues/203) — *Signals UI: relevance-ordered, paged item fetch on load (replace full `network/item/fetch`)*.
**Date:** 2026-07-13 · **Branch:** `feat/ui-caching-strategy` (off `feature`)
**Companion to:** [`2026-07-10-ui-caching-strategy-design.md`](./2026-07-10-ui-caching-strategy-design.md) — that spec fixes caching *mechanics*; this one fixes the *over-fetch those mechanics currently cache*. Land the caching spec first; this builds on its React Query baseline (`createQueryClient`, `lib/query-keys.ts`, `cache_ttl_seconds` plumbing).
**Related (closed):** #202 (configurable fetch limit — shipped as `PROFILE_FETCH_LIMIT`), #117 / #171 (search & discovery / signals-search service).

## 1. Goal & scope

The UI was not built for scale. On load it pulls the **whole network's items** for every visible domain and narrows client-side. The caching spec makes those pulls *cheaper to repeat*; it does not make them *smaller*. This spec reduces what is fetched, tells the user when results are truncated or degraded, and converges the load path with the relevance direction of signals-search.

**The enabling fact:** the server already exposes every knob — `GET /api/v1/network/item/fetch` (`apps/api/src/routes/v1/network/item/fetch_item.ts`, schema `packages/schemas/src/api/item_schemas.ts:60-121`) accepts `item_latitude` + `item_longitude` + `radius_meters` (enforced together), `limit` / `offset`, `cache_ttl_seconds`, and returns `meta: { total, limit, offset, partial, unavailable_instances }`. The gaps are almost entirely **UI-side**.

This design has six parts (Parts 1–4 are the scale fixes; Part 5 is relevance, phased later; Part 6 is optional):

- **1 — Viewport-scoped, count-first browse/map fetch.**
- **2 — Truncation & federation-degradation indicators.**
- **3 — Anonymous browsing: count-first, defer pins.**
- **4 — Cache-key correctness across the new axes.**
- **5 — Relevance ordering via signals-search (design now, phase later).**
- **6 — (optional) persistent client geo cache.**

**Non-goals:** the caching mechanics themselves (covered by the companion spec), server-side inter-instance fan-out (already count-first + slice-merge), map-tile caching, and the signals-search service internals (owned by #117/#171).

---

## 2. Current-state audit (grounded in code)

| # | Behavior | Where | Problem at scale |
|---|---|---|---|
| 1 | Browse fans out **one fetch per visible domain**, each `limit: PROFILE_FETCH_LIMIT` (default **1000**), **no `offset`, no `cache_ttl_seconds`** | `home-page.tsx:556-594`, `lib/network-api.ts` | "All" tab = `1000 × N` items downloaded + rendered; grows with the instance |
| 2 | **No viewport/bbox fetching** — load-all-then-render; clustering is client-side only, no fetch on pan/zoom | `components/map/map-container.tsx`, `providers/*` | Every item in the domain is on the wire regardless of what the user is looking at |
| 3 | **No truncation indicator**; header count is `items.length` post-filter, not `meta.total` | `home-page.tsx:989-991` | "showing 1000, actually 40 000" reads as "1000" — silent data loss |
| 4 | **`meta.partial` / `unavailable_instances` ignored** | consumers of `fetchNetworkItems` | Federated partial results shown (and about to be cached) as if complete |
| 5 | Ordering = server recency (`created_at DESC`) + client nearest-first re-sort; match-score is lazy per-pair on click, never ranks the feed | `apps/api/.../item_fetch_runtime.ts:127`, `home-page.tsx:71-82,509-513`, `hooks/use-match-score.ts` | A logged-in user sees "newest", not "best for me" |
| 6 | `selectedApiUrl` is a **single-backend switcher**, not concurrent fan-out; instance is **not** in any cache key | `lib/api-config.ts`, `lib/api-client.ts` | Switching instance serves stale cross-instance data from React Query and the schema cache |
| 7 | signals-search is **not** queried by UI or API — fed one-way via Redis stream | `apps/api/src/utils/publish_item_event.ts`; no route in `routes/v1/v1_routes.ts` | Relevance ordering needs new API surface (cross-repo) |

> Note: the *set* of domains is already narrowed to the viewer's initiable domains (`computeVisibleDomains`, `visible-domains.ts`); the problem is unbounded fetching *within* each domain.

---

## 3. Design per part

### Part 1 — Viewport-scoped, count-first browse/map fetch

Replace the per-domain `limit: 1000` pull with a **viewport-driven** query.

- **Viewport → geo params.** Derive `item_latitude` / `item_longitude` from the map center and `radius_meters` from the center→corner distance of the current bounds. Refetch on **debounced** `moveend` / `zoomend`. Today the providers' viewport handlers only *drive* the camera (`SetView`, `MapViewController`); add bounds-change listeners that feed the query.
- **Count-first.** Read `meta.total` (already returned) to show the true count and drive Part 2's indicators before/independently of rendering every pin.
- **Paging.** Use `offset` for "load more" within the current viewport/list; keep `PROFILE_FETCH_LIMIT` (#202) as the page size, not a load cap.
- **Cache alignment.** Pass `cache_ttl_seconds` so the client `staleTime` and the server-merged Redis TTL agree (the param is plumbed in `network-api.ts` but never set).
- **List view without location** still paginates by `offset` (no radius filter) — geo is a map concern, not a hard requirement for the list.
- **Viewport bucketing.** Snap center/radius to a grid (e.g. round to a zoom-dependent cell) so small pans reuse cache entries instead of minting a new key per pixel — this is what makes Part 4's keys tractable.

### Part 2 — Truncation & federation-degradation indicators

- **Truncation.** Compare `meta.total` against rendered count → **"Showing X of Y"** with a "zoom in / load more" affordance (`components/layout/content-header.tsx` + a small new indicator). Distinguish three states: *no results*, *complete*, and *truncated — refine/zoom*.
- **Federation degradation.** When `meta.partial` is true (or `unavailable_instances` is non-empty), show **"some instances are unavailable; results may be incomplete."**
- **Cache safety.** Do **not** cache a partial response as if complete — give partial results a short `staleTime`/`gcTime` (or tag them) so a transient peer outage doesn't stick.

### Part 3 — Anonymous browsing: count-first, defer pins

- Below a country/region zoom threshold **with no location**, show the aggregate `meta.total` count + a prompt — **not** thousands of pins. Render pins only after the user zooms to a region or grants location.
- Reuse the existing per-deployment default view (`VITE_MAP_DEFAULT_CENTER` / `VITE_MAP_DEFAULT_ZOOM`, `map-container.tsx:77-117`; whole-India `[20.5937, 78.9629]` @ z5 fallback). The default view becomes a *count + call-to-refine* screen rather than a full pin pull.

### Part 4 — Cache-key correctness across the new axes

Every axis that changes the result **must** be in the React Query key (extend the caching spec's `lib/query-keys.ts` `browseItems(...)`), or one context's data leaks into another's:

| Axis | Source | Why it must be in the key |
|---|---|---|
| rounded viewport / radius bucket | Part 1 | a zoomed-in result must not answer the country view |
| offset / page | Part 1 | pages must not overwrite each other |
| active profile id | `activeProfileId:<net>` (`home-page.tsx:95-109`) | with relevance (Part 5) the ranking basis differs per profile |
| location source | profile vs browser toggle (`hooks/use-user-location.ts`) | changes the anchor point of the query |
| **instance / API base URL** | `lib/api-config.ts` | switching `selectedApiUrl` must bust React Query **and** the schema cache (the caching spec keys schemas by network/brand, **not** by API URL) — audit #6 |

### Part 5 — Relevance ordering via signals-search (design now, phase later)

Target: a **logged-in** user's feed ranked **best-match to the active profile**, not recency+nearest. This is cross-repo, so it phases **after** Parts 1–4.

- **API surface (signals-dpg).** Add a search/relevance path — either a new route in `routes/v1/v1_routes.ts` that proxies signals-search, or a `relevance` mode on `network/item/fetch` — returning ranked item ids/items. This is the "load path and search path converge" acceptance criterion of #203, aligned with #117/#171.
- **UI.** Logged-in browse switches to the ranked source; anonymous browsing stays recency/nearest.
- **Proximity ↔ relevance.** Logged-in default = **best-match** (optionally within a broad radius); expose a **"Near me"** toggle that falls back to Part 1's proximity ordering. Anonymous = nearest/recency.

### Part 6 — (optional, minor) persistent client geo cache

Place→coord is immutable, so a persistent client cache (localStorage/IndexedDB) would help **repeat anonymous visitors** beyond the caching spec's session-only Part B. Low priority; noted, not required.

---

## 4. Flag-back to the caching spec

Author caching-spec **C3 (`lib/query-keys.ts`)** with the Part 4 axes in mind (viewport bucket, offset, active profile, location source, instance URL) so the key factory does not need reworking when this lands. Everything else in the caching spec is unchanged.

---

## 5. Files involved (indicative)

- **Browse/fetch:** `apps/ui/src/pages/home-page.tsx`, `apps/ui/src/tourist/tourist-app.tsx`, `apps/ui/src/lib/network-api.ts` (already supports `offset` / radius / `cache_ttl_seconds` — pass them).
- **Map:** `apps/ui/src/components/map/map-container.tsx` + `providers/leaflet-provider.tsx` / `providers/google-maps-provider.tsx` (bounds→radius, `moveend`/`zoomend` → refetch, zoom threshold), `fit-bounds.tsx`.
- **Indicators:** `apps/ui/src/components/layout/content-header.tsx` + a new "X of Y" / partial-results component.
- **Keys/config:** `apps/ui/src/lib/query-keys.ts` (from caching spec), `apps/ui/src/lib/api-config.ts`.
- **Relevance phase:** `apps/api/src/routes/v1/v1_routes.ts` + a search route + signals-search client.

---

## 6. Phasing / delivery order

1. **Caching spec** (companion) lands first — provides the React Query baseline.
2. **Parts 1–2** — viewport + count-first fetch, truncation/partial indicators (the core of #203).
3. **Parts 3–4** — anon count-first, cache-key correctness (instance/profile/viewport axes).
4. **Part 5** — relevance via signals-search (cross-repo; separate delivery once the API search surface exists).
5. **Part 6** — optional, if repeat-visitor geocoding cost warrants it.

---

## 7. Verification

- Run the UI: `pnpm install && pnpm dev` (API + UI); seed many items across a region (use the largest current instance — UP Blue Dots / Muzaffarnagar, per #203 acceptance).
- **Viewport fetch:** pan/zoom → Network tab shows `item_latitude` / `item_longitude` / `radius_meters` + `offset`; far fewer items than the old `1000 × N`.
- **Truncation:** with total > page, header shows "X of Y" from `meta.total`; "load more" advances `offset`.
- **Anon country view:** shows a count, **not** thousands of pins; pins appear after zoom/location grant.
- **Cache correctness:** switching active profile, location source, or `selectedApiUrl` busts the relevant caches (no stale cross-profile/cross-instance data); schema cache re-fetches on instance switch.
- **Partial federation:** simulate an unavailable peer → UI shows the degradation notice and does not persist the partial result as complete.
- **Tests:** `pnpm typecheck`; `pnpm --filter ui test` for viewport→radius math, count-first, key stability, and partial-result handling.
- **Relevance (phase 2):** logged-in feed orders by match to the active profile; "Near me" toggle falls back to proximity; anonymous unaffected.
