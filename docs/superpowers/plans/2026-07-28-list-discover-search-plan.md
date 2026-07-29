# List PR — ranked/searchable/filterable feed via signals-search `/discover` BFF Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`).

**Goal:** Turn the list view into a ranked, whole-dataset, searchable/filterable feed powered by signals-search `POST /v1/search`, via a new **public `/network/item/discover` BFF**, with a **native fallback** and a clear degraded-UX when the search service is down. Covers the follow-up design's **P-follow-3**.

**Architecture:** A new public Signals-DPG endpoint `POST /api/v1/network/item/discover` (no auth, holds the signals-search API key) translates a UI-friendly body → the signals-search Beckn envelope → `/v1/search`, and returns ranked items + `score`/`distanceMeters`/`meta.total`. If signals-search is unreachable it **falls back to native `/network/item/fetch`** (distance/recency) and marks the response degraded. The UI's `useInfiniteBrowseItems` gains a **discover mode** (used when a search query or facet filters are active, or "Near me" is off), a **"Near me"** toggle (ranked ↔ proximity), and a degraded state.

**Tech Stack:** Fastify + Zod + Drizzle; React 19 + React Query (`useInfiniteQuery`).

## Global Constraints (confirmed decisions)

- **All list traffic via `/discover` with native fallback** (user's choice). Native `/network/item/fetch` (distance/recency) is the fallback + the plain-proximity ("Near me") path.
- **Degraded UX (confirmed):** when signals-search is down AND filters/search are active → prominent banner "Search and filters are temporarily unavailable — showing recent nearby listings" + the filter chips shown as **paused/not-applied** + native results below (do NOT show unfiltered results as if filtered). When NO filters/search active → a subtle "ranking unavailable" note only. Proximity/"Near me" still works natively.
- **Private-field guard:** the BFF must NOT filter on private/undeclared fields (same enumeration risk as the map) — resolve allowed facets from the network config server-side.
- **Page size ≤ 100** (signals-search `PaginationSchema` max); `VITE_PROFILE_PAGE_SIZE` (50) fits; offset pagination (no cursor) → keep `useInfiniteQuery` on offset.
- **Live-only**; **single-instance** for `/discover` in Phase 1 (federated ranked discover is a follow-up; native fallback keeps the umbrella's federation for the fallback path).
- Facet multi-select must reach the BFF as **arrays** (same contract fixed in the Map PR) → the BFF maps them to signals-search `filters` on `item_state.<field>`.
- New backend env vars go in BOTH `packages/config/src/secrets.ts` AND `turbo.json` (`.claude/rules/env-vars.md`).
- Files snake_case; routes never throw (`reply.code().send({error,message})`); ESM/strict-TS/no-`any`/no-`// TODO`; commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `feat/list-discover-search` (off latest `feature`, in a worktree). PR draft.
- Run `pnpm --filter api test`, `pnpm --filter ui test`, `pnpm typecheck` green per commit. Integration needs docker db+redis; **signals-search is NOT run locally** → its calls are **mocked/stubbed** in tests; the native-fallback path is integration-tested against the real local DB.

## ⚠️ Dependency to confirm before Task 2
**The exact signals-search `POST /v1/search` request/response contract** (Beckn envelope shape, `filters`/`textSearch`/`spatial` fields, `score`/`distanceMeters`/`meta` in the response). The design §5 describes it, but the authority is the signals-search service/repo. Confirm from the signals-search repo/docs (or any in-flight #352 integration); if unavailable, define the client type from design §5 and flag it for review. Task 1 (config) + the BFF skeleton + native fallback + all UI plumbing are independent of the exact envelope and can proceed; only the envelope translation (Task 2 core) needs it.

---

## File Structure
- Create: `apps/api/src/routes/v1/network/item/discover.ts` (public BFF), `apps/api/src/services/signals_search_client.ts` (holds URL+key, envelope translate, `/v1/search` call), their `__tests__`.
- Modify: `packages/config/src/secrets.ts` + `turbo.json` (SIGNALS_SEARCH_URL/API_KEY); `apps/api/src/routes/v1/network/network_routes.ts` (register `/discover`); `packages/schemas/src/api/*` (discover body + response schemas).
- UI: `apps/ui/src/lib/network-api.ts` (`fetchDiscover`), `apps/ui/src/hooks/use-infinite-browse-items.ts` (discover mode), `apps/ui/src/pages/home-page.tsx` (Near-me toggle, degraded state, retire list client enum-filtering on the discover path), `apps/ui/src/lib/query-keys.ts` (discover key), i18n locales (degraded copy).

---

## Task 1 — Config: signals-search env
**Files:** `packages/config/src/secrets.ts`, `turbo.json`, `.env.example`.
- [ ] Failing test: config parse requires/So allows `SIGNALS_SEARCH_URL`, `SIGNALS_SEARCH_API_KEY` (optional — absence must NOT crash boot; the BFF just always falls back to native when unset).
- [ ] Add both to `secrets.ts` (Zod, optional) AND `turbo.json` `globalPassThroughEnv`; document in `.env.example`.
- [ ] Commit `feat(config): signals-search URL/API key for the discover BFF (#203)`.

## Task 2 — signals-search client + `/discover` BFF (happy path)
**Files:** `services/signals_search_client.ts`, `routes/v1/network/item/discover.ts`, schemas, route registration.
- [ ] CONFIRM the `/v1/search` contract (see dependency above).
- [ ] Failing test: `POST /discover` with `{network,domain,item_type,q?,filters?,lat?,lng?,page,pageSize}` → the client is called with the correct Beckn envelope (mock the HTTP), and the response maps signals-search items→UI items + `score`/`distanceMeters`/`meta.total`. Page size clamped ≤100; live-only.
- [ ] Implement the client (holds `SIGNALS_SEARCH_URL`/`_API_KEY`, `x-api-key` header) + the public route (no `preHandler`, mirroring `/network/item/fetch`); translate body→envelope→`/v1/search`; map response.
- [ ] **Private/undeclared facet guard:** drop `filters` on fields not declared filterable-or-public in the network config (reuse the map's `resolveAllowedFacetFields`-style helper; server-resolved).
- [ ] Commit `feat(api): public /network/item/discover BFF → signals-search /v1/search (#203)`.

## Task 3 — Native fallback + degraded flag
**Files:** `discover.ts`, schemas.
- [ ] Failing test: when the signals-search call throws/times out, the BFF returns native `/network/item/fetch` (distance/recency) results with `meta.source: 'native_fallback'` (and a `degraded: true`), page size honored — never a 5xx for a search-service outage.
- [ ] Implement the try/catch fallback (reuse `fetchItemsAcrossInstances`/native path). Distinguish: filters/search active vs not, so the UI can show the right message (pass through what was requested).
- [ ] Integration test (docker db, signals-search mocked to fail) → native results returned + `source:native_fallback`.
- [ ] Commit `feat(api): native fallback for the discover BFF when signals-search is down (#203)`.

## Task 4 — UI discover mode
**Files:** `network-api.ts` (`fetchDiscover`), `use-infinite-browse-items.ts`, `query-keys.ts`.
- [ ] Failing test: `useInfiniteBrowseItems` calls `/discover` when a query `q` or facet filters are set (or relevance on); else native browse. Offset paging preserved (≤100). Query key carries q + filters + lat/lng + mode.
- [ ] Implement `fetchDiscover` + the mode switch in the hook; keep the native path for plain proximity browse.
- [ ] Commit `feat(ui): discover mode in useInfiniteBrowseItems (#203)`.

## Task 5 — "Near me" toggle + retire list client-filtering on the discover path
**Files:** `home-page.tsx`, filter panel wiring.
- [ ] Failing test: "Near me" toggles ranked ↔ proximity (re-query); when in discover mode, the list's client-side enum filtering is bypassed (server does it) — but the plain-proximity/native path keeps working. Search box + facet panel drive the `/discover` params.
- [ ] Implement; ensure own-item filtering (hiding the viewer's own profile) still applies.
- [ ] Commit `feat(ui): Near-me toggle + server-side list filtering via discover (#203)`.

## Task 6 — Degraded UX
**Files:** `home-page.tsx`, i18n locales (en/hi/kn).
- [ ] Failing test: when the discover response is `degraded`/`native_fallback` AND filters/search are active → banner + filter chips marked not-applied + native results shown; when not active → subtle "ranking unavailable". "Near me"/proximity still works.
- [ ] Implement + add i18n keys (`list.search_unavailable`, `list.ranking_unavailable`) in en/hi/kn.
- [ ] Commit `feat(ui): degraded 'search unavailable' state when signals-search is down (#203)`.

## Final verification
- [ ] `pnpm typecheck`; `pnpm --filter api test`; `pnpm --filter api test:integration` (signals-search mocked; native fallback real); `pnpm --filter ui test`.
- [ ] Draft PR → `feature` with **In Plain Terms**; flag: single-instance discover (federation follow-up), the signals-search-contract assumption if unconfirmed, and that facet indexes (from the Map PR) accelerate signals-search's JOIN once both merge.

## Out of scope
Relevance-ranked MAP pins (map Phase 2), federated ranked discover, the map bbox work (Map PR).
