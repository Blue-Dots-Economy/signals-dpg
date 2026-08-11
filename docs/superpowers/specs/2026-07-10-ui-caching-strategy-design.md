# Caching strategy — design (Signals UI + geocoding)

**Issue:** [#196](https://github.com/Blue-Dots-Economy/signals-dpg/issues/196) (geocoding cache), expanded into a full caching sweep.
**Date:** 2026-07-10 · **Branch:** `feat/ui-caching-strategy` (off `feature`)
**Companion spec:** [`2026-07-13-ui-data-fetching-at-scale-design.md`](./2026-07-13-ui-data-fetching-at-scale-design.md) (epic [#203](https://github.com/Blue-Dots-Economy/signals-dpg/issues/203)) — this spec fixes caching *mechanics*; the companion reduces the *over-fetch these mechanics cache* (viewport/count-first paging, truncation & partial-federation indicators, relevance ordering). Land this spec first; the companion builds on its React Query baseline.

## 1. Goal & scope

The app caches inconsistently: it is effectively **off by default** (React Query `staleTime: 0`), yet the **heaviest data isn't cached** where it matters, **geocoding is uncached on both tiers**, and there are **parallel ad-hoc caches** plus one **stale-prone forever cache**. This design fixes all of it in four independently-shippable parts:

- **A — Server geocoding cache** (Redis; the literal issue #196).
- **B — Client geocoding cache** (session in-memory).
- **C — React Query standardization + main-page feed caching.**
- **D — Fix/remove the problematic client caches** (schemaCache, focus-refetch, dead hook).

**Non-goals:** changing server item-fetch caching (already correct), map-tile caching (delegated to Leaflet/Google), auth/session storage semantics, or persisting UI view-state.

---

## 2. Current-state audit

### 2a. Cached today

| # | Data | Mechanism | Lifetime / invalidation | Verdict |
|---|---|---|---|---|
| 1 | Actions list + pending count | React Query, key factory, 60s poll, invalidate on status-update | 60s poll | **Keep** (best-built) |
| 2 | Network config (`useNetworkConfig`) | React Query `staleTime 5min` | 5 min | **Keep** (but adopt everywhere) |
| 3 | Consent config (`useConsentConfig`) | React Query `staleTime 5min` | 5 min | **Keep** |
| 4 | Match score | localStorage, 24h TTL, full clear API (`utils/match-score-cache.ts`) | 24h | **Keep** (reference pattern) |
| 5 | Server local item-fetch | Redis, 1s TTL, write-invalidated | 1s | **Keep** (server) |
| 6 | Server inter-instance item-fetch | Redis, `cache_ttl_seconds` (≥ per-network floor, default 300s), write-invalidated | ~5 min | **Keep** (server); UI should *use* the knob |
| 7 | Server network/consent schemas | on-disk tmpdir cache, manual `clearNetworkSchemaCache()` | manual | **Keep** (server) |
| 8 | Client JSON schema cache (`engine/schema/schema-loader.ts`) | in-memory `Map`, no TTL, not network-keyed, dead `clearSchemaCache()` | forever | **REPLACE** (see §3.1) |
| 9 | Global `refetchOnWindowFocus: true` (`main.tsx`) | React Query behavior | every focus | **REMOVE** (see §3.2) |
| 10 | localStorage: `auth_token`, `dpg-theme-mode`, `dpg-active-network`, `activeProfileId:<net>`, `selectedApiUrl`, `i18nextLng` | localStorage | forever (some self-validate) | **Keep** (out of scope; noted §7) |
| 11 | Geo provider *choice* singleton (`lib/geo/provider.ts`) | module `let` | process life | **Keep** (immutable choice; not a data cache) |

### 2b. NOT cached today (gaps)

| # | Data | Where | Impact |
|---|---|---|---|
| G1 | **Server geocoding** (place → coords) | `services/geocoding/geo_resolver.ts` (`resolveCoordinates`), called per-field per-item on create/update | Identical strings re-hit paid Google API; latency + cost + rate-limit pressure. **Issue #196.** |
| G2 | **Client geocoding — autocomplete** | `location-autocomplete-widget.tsx`, `multi-location-autocomplete-widget.tsx` | Billed Places call per keystroke (debounce/abort only, no result cache); backspace-retype refetches. |
| G3 | **Client geocoding — map marker resolution** | `components/map/map-container.tsx:167-245` | Geocodes every location-less item on every `items` change, **no dedup even across items sharing the same address** (50 "Mumbai" profiles → 50 calls); re-runs on domain-tab switch. |
| G4 | **Browse item feed** (others' profiles/postings) | `home-page.tsx:572` / `tourist-app.tsx:64` (`fetchNetworkItems`) — raw `useEffect`+`fetch` | Refetched on every domain-tab switch / navigation; `cache_ttl_seconds` never passed. |
| G5 | **"My profiles" feed** | `home-page.tsx:338`, `profile-form-page.tsx:171/229` (`fetchItems`) — raw fetch | Refetched every mount; no invalidate-on-write coupling. |
| G6 | **Network config on the main pages** | `home-page.tsx:253/287`, `profile-form-page.tsx:106/140` — raw fetch | Same config the tuned hook caches, fetched uncached on the two highest-traffic pages. |

### 2c. Parallel / inconsistent mechanisms (to unify)
- **Two independently-constructed QueryClients** (`main.tsx`, `tourist/main.tourist.tsx`) with near-duplicate-but-drifting defaults.
- **4+ staleTime regimes** for similar "config-ish" data (`0`, `5min`, `poll/Infinity`, `24h localStorage`) with no documented rule.
- **Query keys:** only `use-actions.ts` uses a key factory; everything else inlines ad-hoc arrays; tourist duplicates network/items under a separate key namespace.
- **Invalidation asymmetry:** action *status-update* invalidates `actions`; action *creation* (`performAction`) does not → new actions surface only after the 60s poll.
- **Match-score cache** is invisible to React Query (separate localStorage layer).

### 2d. Redis — what the code writes (server side)
Derived from the code (every path that writes to the shared `redis` client), to decide what stays and what new should go in:

| Written by | Key(s) | TTL / invalidation | Verdict |
|---|---|---|---|
| `utils/item_fetch_cache.ts` | `local-item-fetch:*` | 1s TTL; write-invalidated | **Keep** — valid |
| `utils/inter_instance_fetch.ts` | `item-page:*`, `item-count:*` | `max(~300s per-network floor, cache_ttl_seconds)`; write-invalidated via `invalidateItemFetchCache` (SCAN/UNLINK on create/update/delete/lifecycle) | **Keep** — valid |
| `packages/auth` (better-auth) | session `secondaryStorage` + token keys | session maxAge / `EX 600` | **Keep** — auth, out of scope (not a cache we manage) |
| `utils/publish_item_event.ts` | `signals:item-events` (Redis **Stream**, `xadd`) | **not a cache**; `xadd` has no `MAXLEN` → unbounded | **Out of scope** — it's the search-index event feed, not a cache. Flag a separate search-pipeline ticket to add stream trimming. |
| _(geocoding)_ | — | — | **Nothing today** → Part A adds `geo:place:*` (#196) |

**Conclusion (Redis):** every existing Redis write is valid and **stays** — the item-fetch caches are short-TTL and write-invalidated; auth storage is auth. The **only new** thing this design puts in Redis is the geocoding cache (Part A). **No existing Redis cache is removed** — the three removals in §3 are all **client-side** (React Query / in-memory).

---

## 3. What to REMOVE / disable (with reasoning + safety)

Each removal was checked against the code; none changes user-visible behavior beyond the stated intent.

### 3.1 REPLACE the client `schemaCache` (audit #8) — *stale-prone*
- **Why remove:** `engine/schema/schema-loader.ts:11` is a module-level `Map` that (a) **never expires**, (b) is **not keyed by network/brand**, and (c) has a `clearSchemaCache()` that has **zero callers** (dead) — so a network switch, logout, or a server-side schema redeploy does **not** refresh it; the UI keeps rendering the old form/`$ref` definitions until a hard page reload. It's also a second, uncoordinated layer on top of the server schema cache.
- **Safety:** every consumer (`loadSchema:22-48`, `resolveRefString:71-108`, `resolveRef:209+`) reads the cache **inside an async function and falls through to `await fetch(...)` on a miss** — it is a pure performance memo with no synchronous pre-population assumption. Removing/replacing it only changes *how often* schemas are fetched, never correctness.
- **Replacement (the fix, part D):** keep an in-memory cache but make it correct — key entries by **network/brand + schema URL**, add a **TTL** (align with config tier, ~5 min), and **wire `clearSchemaCache()` to run on network/brand switch** (in `NetworkThemeProvider` where `themeId` changes) and on logout. Net: same speed, no staleness.

### 3.2 DISABLE global `refetchOnWindowFocus: true` (audit #9)
- **Why remove:** set globally in `main.tsx:14`, it makes **every** query refetch whenever the browser tab regains focus — a refetch storm that undercuts the caching this design introduces (e.g. alt-tabbing back re-hits config, feeds, schemas). It is the single biggest reason `staleTime` tuning currently has little effect.
- **Safety:** no query opts into focus-refetch deliberately (`refetchOnWindowFocus` appears **only** as the global `true`). The one place freshness-on-return matters — actions — already refetches via its 60s `refetchInterval`, independent of focus. We set the global to `false` and can opt individual queries back in (`refetchOnWindowFocus: true` per-hook) if a specific need appears.

### 3.3 DELETE dead `useConsentGate` (+ its now-unused `getConsentStatus`)
- **Why remove:** `hooks/use-consent-gate.ts` is built with `staleTime: 0` but is **never imported anywhere** (confirmed repo-wide). `lib/consent-api.ts:getConsentStatus` is called **only** by this dead hook.
- **Safety:** 0 importers → deleting the hook is inert. `getConsentStatus` becomes unused and is removed with it (the server endpoint is untouched; the live consent gate the app actually uses is `getProfileConsentStatus` on `home-page`, which stays).

> Note: localStorage hygiene (`auth_token` expiry check, clearing `activeProfileId:*` on logout) was considered but is **out of scope** for this caching design — tracked separately; called out in §7.

---

## 4. What NEEDS caching — design per part

### A. Server geocoding cache (Redis) — issue #196

Wrap the geocode entry point with a Redis get-or-load-and-set, mirroring `apps/api/src/utils/item_fetch_cache.ts`.

- **Where:** in `geo_resolver.ts` `resolveCoordinates(query)` — the single choke point both `resolveWithGoogle` and `resolveWithPhoton` pass through, and which every create/update path reaches via `resolveLocationsForCreate` / `geocodeLocationsFromState`.
- **Key:** `geo:place:<normalized>` where `normalized` = lowercase + trim + collapse internal whitespace of the query string (a small `normalizeGeoKey()` helper so case/spacing variants share an entry). *(Design decision: normalization is deliberately minimal — do not fold distinct place strings together.)*
- **Value:** the resolved `{ lat, lng }` (the current result shape). Store the **exact** resolved coordinate — PII jitter is applied downstream at the storage choke point, so caching the pre-jitter fact is correct and reusable.
- **Positive TTL:** `GEO_CACHE_TTL_SECONDS`, default **30 days** (places are stable).
- **Negative cache:** on a no-result/failed resolve, store a sentinel with `GEO_CACHE_NEGATIVE_TTL_SECONDS`, default **1 hour**, so unresolvable strings don't hammer the API.
- **Resilience:** best-effort — a Redis `get`/`set` error must **fall through to a live provider call** and never fail the resolve (Redis is a hard dep everywhere, but a cache miss/error is non-fatal).
- **Env:** add `GEO_CACHE_TTL_SECONDS` + `GEO_CACHE_NEGATIVE_TTL_SECONDS` to `packages/config/src/secrets.ts` **and** `turbo.json` `globalPassThroughEnv`.
- **No write-invalidation needed:** a place string is an immutable input to a stable external fact (unlike item-fetch), so a TTL alone suffices — simpler than the item-cache's SCAN/UNLINK machinery.

### B. Client geocoding cache (session, in-memory)

A shared, session-scoped cache behind the geo provider, keyed by normalized query, that all three client geocoding call sites use.

- **Where:** a small module (e.g. `lib/geo/geo-cache.ts`) exposing a memoizing wrapper; `getGeoProvider()` returns a provider whose `suggest`/`geocode` are wrapped so the cache is transparent to callers.
- **Structure:** an in-memory `Map` (bounded LRU, cap ~500 entries) keyed by `normalizeGeoKey(query)` (same normalization concept as A). **Dedup in-flight identical lookups** (store the pending `Promise`) so concurrent identical calls collapse to one request.
- **Covers:**
  - **Autocomplete** (`location-autocomplete-widget`, `multi-location-autocomplete-widget`) — dedup repeated substrings / backspace-retype / re-opening the same field.
  - **Map marker resolution** (`map-container.tsx`) — dedup across items sharing the same address *and* across re-runs (domain-tab switches). Highest-value target.
  - **Submit-time resolve** (`profile-form-page.tsx`) — benefits from the same session cache (user often just picked the address in the autocomplete seconds earlier).
- **Lifetime:** session only (cleared on reload). **No persistence** — place→coord is effectively immutable so staleness risk is nil, and this avoids localStorage growth/eviction concerns.

### C. React Query standardization + main-page feed caching

**Server vs client — the browse feed is cached on the server, NOT the client.** `GET /api/v1/network/item/fetch` is already cached server-side (Redis `item-page:*` / `item-count:*`, TTL = `max(per-network floor ~300s, cache_ttl_seconds)`, write-invalidated). But the UI (`home-page.tsx:572`, `tourist-app.tsx:64`) fetches it with a raw `useEffect`+`fetch` and **no client cache**, so every domain-tab switch / navigation fires a fresh HTTP round-trip (+ JSON download + re-render) even when the server answers instantly from Redis — and it never passes `cache_ttl_seconds`. Part C adds the **missing client layer**: with React Query the tab switch is served from browser memory (zero network call), your own edits still refresh immediately via invalidate-on-write, and the two layers stack (server cache avoids recomputation; client cache avoids the round-trip).

**C1 — One QueryClient, shared config.** Extract a single `createQueryClient()` (or shared `defaultOptions`) used by both `main.tsx` and `tourist/main.tourist.tsx`. Defaults: **`refetchOnWindowFocus: false`** (§3.2), `retry: 2`, default `gcTime`; **no global `staleTime: 0`** — staleTime is set per query via the tier policy below.

**C2 — staleTime tiers (the documented policy).**

| Tier | Data | staleTime | Freshness mechanism |
|---|---|---|---|
| Config | network config, consent config, resolved schemas | **5 min** | TTL + invalidate on network/brand switch |
| Browse feed | others' profiles/postings (`/network/item/fetch`) | **~90s (1–2 min band)** | TTL; backend cache (~5min) absorbs the rest |
| Own data | my profiles (`/item/fetch created_by_me`) | 60s | **invalidate-on-write** (create/edit) → immediate |
| Actions | action list, pending count | 60s poll (unchanged) | `refetchInterval` + invalidate on write |

**C3 — Central query-key factory.** A `lib/query-keys.ts` (extending the `use-actions.ts` `actionKeys` pattern) for `networkConfig`, `consentConfig`, `schemas`, `browseItems(network,domain,filters)`, `myItems(network)`, `actions`, etc. The tourist app reuses these keys / the `useNetworkConfig` hook instead of its separate namespace.

> Flag-back (companion spec [#203](https://github.com/Blue-Dots-Economy/signals-dpg/issues/203)): author `browseItems(...)` — and the schema-cache key (§3.1) — to anticipate the axes the companion spec adds, so the factory does not need reworking: rounded **viewport/radius bucket**, **offset/page**, **active profile id**, **location source**, and the **instance/API base URL** (switching `selectedApiUrl` must bust both React Query and the schema cache).

**C4 — Migrate the raw-fetch pages to React Query (full migration).**
- `home-page.tsx`: replace the raw `useEffect`/`AbortController` fetches for network config (`:253/:287`), my-profiles (`:338`), and browse items (`:572`) with `useQuery` using the keys/tiers above. Keep `getProfileConsentStatus` behavior but move its state into a query (or keep local — see C5).
- `profile-form-page.tsx`: same for network config (`:106/:140`) and edit-mode item lookup (`:171/:229`).
- Reuse `useNetworkConfig`/`useConsentConfig` rather than re-fetching.

**C5 — Invalidate-on-write (close the asymmetry).**
- Profile **create/edit** (`createItem`/`updateItem`, `profile-form-page`) → `invalidateQueries` on `myItems` + the relevant `browseItems` so the user sees their change immediately.
- Action **creation** (`performAction`/`performActionsBulk`, `home-page`) → wrap as a mutation (or call `invalidateQueries(actionKeys.all)` on success), matching the existing status-update path so new actions don't wait for the 60s poll.
- Profile-consent accept → `invalidateQueries` instead of the hand-managed `consentedProfileIds` `Set` (or keep local state but document it).

**C6 — Use the backend knob.** Pass `cache_ttl_seconds` from the browse-feed query to `/network/item/fetch` so the client staleTime and the server TTL are aligned (the param is already plumbed in `network-api.ts` but never set).

### D. Client schema cache correctness
Covered as the **replacement** in §3.1: network/brand-keyed, TTL'd, invalidation wired to network switch + logout. (Grouped with removals because it *is* the fix for the removed cache.)

---

## 5. Cross-cutting: the caching rule (so future data lands in the right tier)
Document in code (a short comment block on `createQueryClient` / `query-keys.ts`) and in `AGENTS.md`/CLAUDE.md:
> **Config-like, rarely-changing** data → React Query, `staleTime` 5 min, invalidate on the event that changes it. **Feeds of others' data** → `staleTime` ~1–2 min. **The user's own data** → short `staleTime` + invalidate-on-write. **Polled/near-real-time** → `refetchInterval`. **Expensive external lookups keyed by immutable input** (geocode) → dedicated cache (Redis server-side long-TTL; in-memory client-side session). **Never** rely on `refetchOnWindowFocus` for freshness. **One** QueryClient config, **one** key factory.

---

## 6. Testing
- **A:** unit tests — cache miss → provider called → stored; repeat → hit (0 provider calls, via mock/count); negative-result cached briefly; Redis-error falls through to a live call; TTLs read from env. Existing geocoding tests still pass.
- **B:** unit tests — identical normalized queries hit the cache (1 network call for N calls); in-flight dedup; LRU cap eviction; distinct queries don't collide.
- **C:** hook/component tests — feeds served from cache within staleTime (no refetch on remount); invalidate-on-write refetches; key-factory keys are stable; single QueryClient. `pnpm typecheck` + `pnpm --filter ui test` clean.
- **D:** schema cache keyed by network → switching network re-fetches; TTL expiry re-fetches; `clearSchemaCache` invoked on network switch. Assert `useConsentGate`/`getConsentStatus` removed with no dangling imports; `refetchOnWindowFocus` default is `false`.

## 7. Phasing / delivery order
Independently shippable; recommended order:
1. **A** (server geocoding) — self-contained, directly closes #196.
2. **B** (client geocoding) — self-contained, no cross-cutting risk.
3. **D + removals** (schemaCache replacement, `refetchOnWindowFocus` off, delete dead hook) — small, de-risks C.
4. **C** (React Query standardization + main-page migration) — largest; lands last on the cleaned-up baseline.

## 8. Out of scope (tracked separately)
- localStorage hygiene: `auth_token` client-side expiry check; clearing `activeProfileId:*` on logout.
- Map-tile caching / OSM rate-limit fallback (`leaflet-provider`).
- Static-bundle CDN/`Cache-Control` headers (nginx).
- Reconciling match-score's localStorage cache into a common utility (it works; keep as the reference pattern).
