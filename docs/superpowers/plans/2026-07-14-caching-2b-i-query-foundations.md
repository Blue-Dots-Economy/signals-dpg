# Caching Phase 2b-i — React Query Foundations — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the shared React Query baseline the rest of Part C builds on — one `createQueryClient()` used by both entry points, and one central `lib/query-keys.ts` key factory adopted by the existing config/action hooks.

**Architecture:** Extract the duplicated inline `QueryClient` configs (`main.tsx`, `tourist/main.tourist.tsx`) into a single `createQueryClient()`. Add a central key factory (extending the existing `actionKeys` shape) that the config hooks adopt now, and that pre-declares the `browseItems`/`myItems`/`markers` keys the page-migration (Plan 2b-ii) and the #203 scale work (§8) will consume — so the factory never needs reworking mid-migration.

**Tech Stack:** React 19 + Vite, TypeScript (ESM, strict), Vitest, @tanstack/react-query.

**Epic context:** Phase 2b-i of the #203 umbrella. Implements caching-spec (`docs/superpowers/specs/2026-07-10-ui-caching-strategy-design.md`) Part C's **C1** (one QueryClient) and **C3** (central key factory), plus the umbrella §11 flag-back (author `browseItems(...)` + a `markers(...)` key ahead of the §8 axes). **Deferred to Plan 2b-ii:** C4 page migration, C5 invalidate-on-write, C6 `cache_ttl_seconds`, C2 staleTime tiers applied to feeds, the schemaCache §3.1 replacement, and §8 instance-URL busting. Phases 1, 2a already merged/pushed on this branch.

## Global Constraints

- **Branch:** all work lands on `feat/ui-caching-strategy`. Do NOT commit to `feature` or `develop`.
- **ESM only, strict TS, no `any`.** UI filenames are kebab-case. No `// TODO`.
- **No behavior change to pages.** This plan only introduces the factory + shared client and re-points existing hook keys to identical values. Existing query-key VALUES must be preserved exactly so no cache is silently busted: `network-config` key stays `['network-config', networkId]`; consent-config key stays `['consent-config', themeId, brand]`; action keys stay rooted at `['actions', ...]`.
- **`createQueryClient` defaults:** `refetchOnWindowFocus: false`, `retry: 2`. Do NOT set a global `staleTime` (React Query's default is already `0`; per-query staleTime tiers are Plan 2b-ii). This also brings the tourist entry point to `refetchOnWindowFocus: false` (it defaulted to `true` before — a 2a-review follow-up).
- **Keys defined-ahead but unused are intentional** (spec §11 flag-back): `browseItems`, `myItems`, and `markers` are consumed in Plan 2b-ii / the #203 scale work; document that inline.

## File Structure

- `apps/ui/src/lib/query-client.ts` — **create**: `createQueryClient()`.
- `apps/ui/src/lib/query-client.test.ts` — **create**: unit test for defaults.
- `apps/ui/src/main.tsx` — **modify**: use `createQueryClient()`.
- `apps/ui/src/tourist/main.tourist.tsx` — **modify**: use `createQueryClient()`.
- `apps/ui/src/lib/query-keys.ts` — **create**: central key factory.
- `apps/ui/src/lib/query-keys.test.ts` — **create**: key-shape tests.
- `apps/ui/src/hooks/use-network-config.ts` — **modify**: use `queryKeys.networkConfig`.
- `apps/ui/src/hooks/use-consent-config.ts` — **modify**: use `queryKeys.consentConfig`.
- `apps/ui/src/hooks/use-actions.ts` — **modify**: source `actionKeys` from the factory (re-export for existing consumers).

---

### Task 1: `createQueryClient()` shared factory

**Files:**
- Create: `apps/ui/src/lib/query-client.ts`
- Create: `apps/ui/src/lib/query-client.test.ts`
- Modify: `apps/ui/src/main.tsx:10-18`
- Modify: `apps/ui/src/tourist/main.tourist.tsx:28`

**Interfaces:**
- Produces: `createQueryClient(): QueryClient` — a new client with `defaultOptions.queries = { refetchOnWindowFocus: false, retry: 2 }`.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/lib/query-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { createQueryClient } from './query-client';

describe('createQueryClient', () => {
  it('disables focus-refetch and sets retry to 2', () => {
    const client = createQueryClient();
    const q = client.getDefaultOptions().queries;
    expect(q?.refetchOnWindowFocus).toBe(false);
    expect(q?.retry).toBe(2);
  });

  it('does not set a global staleTime (per-query tiers own it)', () => {
    const client = createQueryClient();
    expect(client.getDefaultOptions().queries?.staleTime).toBeUndefined();
  });

  it('returns a fresh instance each call', () => {
    expect(createQueryClient()).not.toBe(createQueryClient());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/lib/query-client.test.ts`
Expected: FAIL — cannot resolve `./query-client`.

- [ ] **Step 3: Implement `query-client.ts`**

Create `apps/ui/src/lib/query-client.ts`:

```ts
import { QueryClient } from '@tanstack/react-query';

/**
 * The single React Query client factory for the app. Both entry points
 * (`main.tsx`, `tourist/main.tourist.tsx`) use this so their defaults can't
 * drift. `refetchOnWindowFocus` is off (freshness comes from per-query
 * staleTime tiers and, for actions, refetchInterval — never from focus). No
 * global `staleTime` is set: React Query defaults to 0, and per-query tiers
 * (Plan 2b-ii) set it where caching is wanted.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: false,
        retry: 2,
      },
    },
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/lib/query-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire both entry points**

In `apps/ui/src/main.tsx`, replace the inline `const queryClient = new QueryClient({...})` block with:

```ts
import { createQueryClient } from '@/lib/query-client';
```
```ts
const queryClient = createQueryClient();
```
(Remove the now-unused `QueryClient` import from `@tanstack/react-query` if `QueryClientProvider` is the only other symbol used — keep `QueryClientProvider`.)

In `apps/ui/src/tourist/main.tourist.tsx`, replace the inline `const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 0, retry: 2 } } });` with:

```ts
import { createQueryClient } from '@/lib/query-client';
```
```ts
const queryClient = createQueryClient();
```
(Remove the now-unused `QueryClient` import; keep `QueryClientProvider`.)

- [ ] **Step 6: Verify**

Run: `pnpm typecheck`
Expected: PASS (no unused-import or type errors).

Run: `pnpm --filter ui test`
Expected: PASS — full UI suite green (both entry points still construct a client; no behavior regression).

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/lib/query-client.ts apps/ui/src/lib/query-client.test.ts apps/ui/src/main.tsx apps/ui/src/tourist/main.tourist.tsx
git commit -m "refactor(ui): single createQueryClient() shared by both entry points

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Central `lib/query-keys.ts` factory + adopt in existing hooks

**Files:**
- Create: `apps/ui/src/lib/query-keys.ts`
- Create: `apps/ui/src/lib/query-keys.test.ts`
- Modify: `apps/ui/src/hooks/use-network-config.ts:21` (queryKey)
- Modify: `apps/ui/src/hooks/use-consent-config.ts:32` (queryKey)
- Modify: `apps/ui/src/hooks/use-actions.ts:21-29` (source `actionKeys` from the factory)

**Interfaces:**
- Produces `queryKeys` with (values chosen to preserve existing keys exactly):
  - `queryKeys.networkConfig(networkId: string) => ['network-config', networkId]`
  - `queryKeys.consentConfig(themeId: string, brand: string | null) => ['consent-config', themeId, brand]`
  - `queryKeys.actions` — an object mirroring the current `actionKeys` (`all`/`lists`/`list`/`details`/`detail`/`pendingCount`), rooted at `['actions']`.
  - **Defined-ahead for Plan 2b-ii / §8 (documented, unused in 2b-i):**
    - `queryKeys.myItems(networkId: string) => ['my-items', networkId]`
    - `queryKeys.browseItems(networkId, domain, filters) => ['browse-items', networkId, domain, filters]`
    - `queryKeys.markers(networkId, domain, filters) => ['markers', networkId, domain, filters]`
  - Re-export `actionKeys = queryKeys.actions` from `use-actions.ts` so existing importers are unaffected.

- [ ] **Step 1: Write the failing tests**

Create `apps/ui/src/lib/query-keys.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { queryKeys } from './query-keys';

describe('queryKeys', () => {
  it('preserves the existing network-config key value', () => {
    expect(queryKeys.networkConfig('blue_dot')).toEqual(['network-config', 'blue_dot']);
  });

  it('preserves the existing consent-config key value (brand may be null)', () => {
    expect(queryKeys.consentConfig('blue_dot', 'onetac')).toEqual(['consent-config', 'blue_dot', 'onetac']);
    expect(queryKeys.consentConfig('blue_dot', null)).toEqual(['consent-config', 'blue_dot', null]);
  });

  it('roots action keys at ["actions"] with the same shape as before', () => {
    expect(queryKeys.actions.all).toEqual(['actions']);
    expect(queryKeys.actions.pendingCount()).toEqual(['actions', 'pendingCount']);
    expect(queryKeys.actions.detail('abc')).toEqual(['actions', 'detail', 'abc']);
  });

  it('defines browse/my-items/markers keys for later phases', () => {
    expect(queryKeys.myItems('blue_dot')).toEqual(['my-items', 'blue_dot']);
    const f = { limit: 50, offset: 0 };
    expect(queryKeys.browseItems('blue_dot', 'seeker', f)).toEqual(['browse-items', 'blue_dot', 'seeker', f]);
    expect(queryKeys.markers('blue_dot', 'seeker', f)).toEqual(['markers', 'blue_dot', 'seeker', f]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter ui exec vitest run src/lib/query-keys.test.ts`
Expected: FAIL — cannot resolve `./query-keys`.

- [ ] **Step 3: Implement `query-keys.ts`**

Create `apps/ui/src/lib/query-keys.ts`. Import the action filter type from where it lives (`FetchMyActionsQuery` — confirm its export path in `use-actions.ts`; it is used by the current `actionKeys.list`):

```ts
import type { FetchMyActionsQuery } from '@/lib/action-api';

/**
 * Central query-key factory. One source of truth for React Query keys so keys
 * never drift across hooks/pages. Values for existing hooks are preserved
 * exactly (network-config / consent-config / actions) so adopting the factory
 * does not bust any live cache.
 *
 * `myItems` / `browseItems` / `markers` are declared ahead of use (spec §11
 * flag-back): the page migration (Plan 2b-ii) and the #203 scale work consume
 * them, and browse/markers filters must eventually carry the §8 axes (rounded
 * viewport bucket, offset, active profile, location source, instance URL).
 */
const actions = {
  all: ['actions'] as const,
  lists: () => [...actions.all, 'list'] as const,
  list: (filters: FetchMyActionsQuery) => [...actions.lists(), filters] as const,
  details: () => [...actions.all, 'detail'] as const,
  detail: (actionId: string) => [...actions.details(), actionId] as const,
  pendingCount: () => [...actions.all, 'pendingCount'] as const,
};

export const queryKeys = {
  networkConfig: (networkId: string) => ['network-config', networkId] as const,
  consentConfig: (themeId: string, brand: string | null) =>
    ['consent-config', themeId, brand] as const,
  actions,
  myItems: (networkId: string) => ['my-items', networkId] as const,
  browseItems: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['browse-items', networkId, domain, filters] as const,
  markers: (networkId: string, domain: string, filters: Record<string, unknown>) =>
    ['markers', networkId, domain, filters] as const,
};
```

> If `FetchMyActionsQuery` is not exported from `@/lib/action-api`, use the same import path `use-actions.ts` currently uses for it (grep `use-actions.ts` for the import) — do not invent a new type.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter ui exec vitest run src/lib/query-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Adopt the factory in the existing hooks**

In `apps/ui/src/hooks/use-network-config.ts`, replace the inline `queryKey` (currently `[NETWORK_CONFIG_KEY, networkId]`) with `queryKeys.networkConfig(networkId)` (import `queryKeys` from `@/lib/query-keys`; remove the now-unused `NETWORK_CONFIG_KEY` const if nothing else uses it).

In `apps/ui/src/hooks/use-consent-config.ts`, replace the inline `queryKey: ['consent-config', themeId, brand]` with `queryKeys.consentConfig(themeId, brand)` (import `queryKeys`).

In `apps/ui/src/hooks/use-actions.ts`, remove the local `actionKeys` object definition and instead:
```ts
import { queryKeys } from '@/lib/query-keys';
export const actionKeys = queryKeys.actions;
```
(so every existing `actionKeys.*` reference in the file and any external importer keeps working unchanged).

- [ ] **Step 6: Verify**

Run: `pnpm typecheck`
Expected: PASS (a mismatched key type or missing export fails here).

Run: `pnpm --filter ui test`
Expected: PASS — full UI suite green. The action hooks and consent-config hooks behave identically (same key values), and no test asserts the removed `NETWORK_CONFIG_KEY` const.

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/lib/query-keys.ts apps/ui/src/lib/query-keys.test.ts apps/ui/src/hooks/use-network-config.ts apps/ui/src/hooks/use-consent-config.ts apps/ui/src/hooks/use-actions.ts
git commit -m "refactor(ui): central query-keys factory adopted by config/action hooks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** C1 (one QueryClient) → Task 1. C3 (central key factory) → Task 2, incl. the §11 flag-back keys (`browseItems`/`myItems`/`markers`) declared ahead. Deferred items (C2 tiers on feeds, C4 migration, C5 invalidate-on-write, C6 cache_ttl, schemaCache §3.1, §8 instance-URL busting) are explicitly listed as Plan 2b-ii scope — not silently dropped.

**Placeholder scan:** none — full code + exact commands. The one conditional (`FetchMyActionsQuery` import path) has an explicit grounding instruction, not a guess.

**Type consistency:** `createQueryClient(): QueryClient`; `queryKeys.*` return values match the tests and preserve existing key values; `actionKeys = queryKeys.actions` keeps the `.all/.lists/.list/.details/.detail/.pendingCount` surface used across `use-actions.ts`.

**No-behavior-change check:** key values are byte-identical to today's, so no live query cache is invalidated by adoption; the only intentional behavior delta is the tourist entry point gaining `refetchOnWindowFocus: false` (a wanted 2a follow-up).

## Notes for Plan 2b-ii
- Migrate home-page raw fetches (networks list 250–274, selected network config 277–302, my-profiles 321–385, browse items 556–594) and profile-form-page (103–122, 134–155, edit lookup 158–210, domain-lock probe 220–246) to `useQuery` using `queryKeys` + the C2 staleTime tiers (config 5min, browse ~90s, own-data 60s).
- Invalidate-on-write: `createItem`/`updateItem` (profile-form-page 407/439) → `queryKeys.myItems` + `queryKeys.browseItems`; `performAction`/`performActionsBulk` (home-page 713/1160) → `queryKeys.actions.all`; consent-accept (home-page 931) → invalidate instead of the `consentedProfileIds` Set.
- `cache_ttl_seconds` (C6): pass from the browse-items query (network-api.ts already plumbs it, no caller sets it).
- schemaCache §3.1: add TTL to `schema-loader.ts` (Map → `{schema, expiresAt}`; `getCachedSchema` honors expiry) and wire `clearSchemaCache()` to the `NetworkThemeProvider` themeId-change effect (theme-provider.tsx 207–209) + the logout path (locate it).
- §8 instance-URL busting: `selectedApiUrl` (`api-config.ts`) must enter the browse/my-items/markers/schema keys so switching instance serves fresh data; `createApiClient` captures `baseURL` at construction (api-client.ts:8), so a switch also needs the query client's cache cleared or the key varied by selected instance.
