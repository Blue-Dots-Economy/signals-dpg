# Personalized discover relevance — profile anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rank the list feed by relevance to the viewer's **selected own profile** — send that profile's `item_id` as the signals-search **anchor** (`intent.item.id`) so the other side's items come back ranked to the viewer (seeker profile → provider job_postings, and vice-versa).

**Architecture:** signals-search already implements the anchor path + cross-domain "interaction matrix" ranking (`/v1/search` `intent.item.id`; `src/api/search_route.ts` resolves the anchor's embedding and does NOT scope by domain/type). So this is **DPG + UI plumbing only** — thread an anchor id from the UI (`activeProfileId`) → `/discover` BFF → the signals-search client's `intent.item`. If signals-search rejects the pairing or the anchor isn't indexed (`404 ANCHOR_NOT_FOUND`), the BFF retries once **without** the anchor (keeps query/default ranking) instead of degrading to native.

**Tech Stack:** Fastify + Zod + Drizzle; React 19 + React Query (`useInfiniteQuery`).

## Global Constraints (confirmed product decisions)

- **Anchor = the viewer's SELECTED profile** (`activeProfileId`). Changing the selected profile must re-query → the anchor id is part of the React Query key.
- **Default (no `q`) list = personalized:** in relevance/discover mode with a selected profile, send the anchor so the default feed is ranked to that profile.
- **`q` + anchor together:** when the user also types a search, send BOTH `textSearch` and the anchor (signals-search supports it) — do not drop one for the other.
- **Anonymous / no selected profile → no anchor** → the existing generic ranked/default feed (never an error).
- **Anchor is unauthenticated (accepted):** `/discover` is public and cannot verify the anchor belongs to the caller; it only reorders already-public masked items and signals-search enforces the interaction matrix. Flag this in the PR description.
- Anchor only affects the **discover** path; the native browse/fallback path ignores it.
- Files snake_case; routes never throw (`reply.code().send({error,message})`); ESM/strict-TS/no-`any`/no-`// TODO`; `import type` for types. Commit trailer `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. Branch `feat/discover-anchor-relevance` (off latest `feature`). PR draft, `Part of #394`.
- Green per commit: `pnpm --filter api test`, `pnpm --filter ui test`, `pnpm typecheck`. signals-search is MOCKED in tests (not run locally). Regenerate `openapi.json` when the discover contract changes (`pnpm --filter api spec:dump`).

---

## Task 1 — Backend: anchor through the client + BFF, typed error + retry-without-anchor
**Files:** `apps/api/src/services/signals_search_client.ts`, `packages/schemas/src/api/discover_schemas.ts`, `apps/api/src/routes/v1/network/item/discover.ts`, `openapi.json`, colocated `__tests__`.

**Interfaces produced (later tasks rely on these):**
- `DiscoverItemsBody` gains `anchor_item_id?: string (uuid)`.
- `SearchSignalsInput` gains `anchorItemId?: string`.

- [ ] Failing test (client): `buildSignalsSearchRequest({..., anchorItemId})` puts `intent.item = { id: anchorItemId }`; omits `intent.item` when `anchorItemId` is undefined.
- [ ] Implement: add `anchorItemId?: string` to `SearchSignalsInput`; add `item: z.object({ id: z.string() }).optional()` to the client request schema's `intent`; in `buildSignalsSearchRequest` add `...(input.anchorItemId ? { item: { id: input.anchorItemId } } : {})`.
- [ ] Failing test (client typed error): a non-2xx response makes `searchSignals` throw a typed `SignalsSearchError` carrying `status` (number) and `code` (the upstream body's `error`, e.g. `'ANCHOR_NOT_FOUND'`).
- [ ] Implement: define/export `class SignalsSearchError extends Error { status?: number; code?: string }`; throw it in the `!response.ok` branch (parse `errorBody.error` → `code`, `response.status` → `status`). Keep the message format.
- [ ] Add `anchor_item_id: z.string().uuid().optional()` to the discover request body schema (`DiscoverItemsBodyBase`).
- [ ] Failing test (BFF): `POST /discover` with `anchor_item_id` calls `searchSignals` with `anchorItemId`; a `SignalsSearchError` with `status:404`/`code:'ANCHOR_NOT_FOUND'` (when an anchor was sent) makes the BFF **retry `searchSignals` once WITHOUT the anchor** and return `source:'signals_search'`, `degraded:false` (NOT native_fallback). A non-anchor error (or a retry that also fails) still → native fallback + `degraded:true`.
- [ ] Implement in `discover_items_handler`: pass `anchorItemId: body.anchor_item_id` into the `searchSignals` call. In the search `catch`, if `body.anchor_item_id` was set AND the error is a `SignalsSearchError` with `status === 404` (or `code === 'ANCHOR_NOT_FOUND'`), retry `searchSignals` with the same input minus `anchorItemId`; on success map+return as `signals_search`. Otherwise keep the existing native-fallback path.
- [ ] `pnpm --filter api spec:dump` (regenerate openapi.json); `pnpm --filter api test`; `pnpm typecheck`.
- [ ] Commit `feat(api): discover accepts a profile anchor for signals-search relevance (#394)`.

## Task 2 — UI: fetchDiscover anchor + hook threading + query key
**Files:** `apps/ui/src/lib/network-api.ts`, `apps/ui/src/hooks/use-infinite-browse-items.ts`, colocated tests.

**Interfaces produced:** `useInfiniteBrowseItems` opts gains `anchorItemId?: string`.

- [ ] Failing test (network-api): `fetchDiscover` includes `anchor_item_id` in the POST body when provided, omits it otherwise.
- [ ] Implement: add `anchor_item_id?: string` to `FetchDiscoverQuery`; include it in the request body when set.
- [ ] Failing test (hook): with `opts.anchorItemId` set and in discover mode, `fetchDiscover` is called with `anchor_item_id`; and the query key changes when `anchorItemId` changes (so a profile switch resets paging / refetches). Native mode does not send/require it.
- [ ] Implement: add `anchorItemId?: string` to the hook opts; pass `...(anchorItemId ? { anchor_item_id: anchorItemId } : {})` into the `fetchDiscover` body; include `anchorItemId` in the query-key `filterKey` **only on the discover path** (so a profile switch in native mode doesn't cause a needless refetch).
- [ ] `pnpm --filter ui test`; `pnpm typecheck`.
- [ ] Commit `feat(ui): thread profile anchor into discover mode + query key (#394)`.

## Task 3 — UI: home-page sends the selected profile as the anchor
**Files:** `apps/ui/src/pages/home-page.tsx`, tests as feasible.

- [ ] Failing test: the discover opts derived on the page carry `anchorItemId = activeProfileId` when a profile is selected, and `undefined` when none is selected (extract a tiny pure helper if home-page can't be mounted — mirror the Task 5/6 `browse-discover.ts` helper pattern).
- [ ] Implement: include `anchorItemId: activeProfileId ?? undefined` in `browseHookOpts` (the object already passed to both `singleDomainList` and each `DomainPagedFetch`), so both list paths anchor to the selected profile. Because `browseHookOpts` is memoized on its inputs, a change to `activeProfileId` produces new opts → new query key (Task 2) → re-query. No other call-site change needed.
- [ ] Confirm native/proximity path and the map are unaffected (anchor only used in discover mode; map never calls discover).
- [ ] `pnpm --filter ui test`; `pnpm typecheck`.
- [ ] Commit `feat(ui): anchor the discover list to the selected profile (#394)`.

## Final verification
- [ ] `pnpm typecheck`; `pnpm --filter api test`; `pnpm --filter ui test`.
- [ ] Draft PR → `feature`, `Part of #394`, **In Plain Terms**; flag: the unauthenticated anchor (decision 5), that personalization needs the anchor indexed in `item_search` (draft/unindexed profile → retry-without-anchor → generic ranking), and that the interaction-matrix pairing (which anchor domain may rank which target domain) is signals-search config to confirm in dev.

## Out of scope
Relevance-ranked MAP pins (P-follow-5), the `SIGNALS_SEARCH_URL` path-append fix (separate concern), federated ranked discover.
