# Caching Phase 2b-iii — profile-form-page → React Query — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the four raw `useEffect`/`AbortController`/`fetch` data loads in `profile-form-page.tsx` with React Query `useQuery` hooks driven by the `lib/query-keys.ts` factory and the caching-spec staleTime tiers, so config and own-data reads are cached, deduped, and shared with the rest of the app instead of re-fetched on every mount/navigation.

**Architecture:** Extract four small, reusable hooks — `useNetworkConfigs` (networks list), `useResolvedNetwork` (config fetch + `$ref` resolution), `useMyItems` (my items across served domains), `useEditItem` (edit-mode item lookup) — each keyed via the central factory and tiered per the spec. Then convert the page to consume these hooks: fetching state (`resolvedNetwork`, `availableNetworkIds`, `myItems`, `isLoading`) becomes derived query state; the only remaining local state is what the user mutates in the form (`initialData`, `selectedDomain`, `existingItem`, form flags). Query functions stay pure data-fetchers; the page's side effects (seed edit form, toast/redirect on not-found) live in effects that react to query results.

**Tech Stack:** React 19 + Vite, TypeScript (ESM, strict), `@tanstack/react-query` v5, Vitest + `@testing-library/react`.

**Epic context:** Phase 2b-iii of the #203 umbrella, implementing caching-spec (`docs/superpowers/specs/2026-07-10-ui-caching-strategy-design.md`) **Part C** for `profile-form-page.tsx` — §C2 tiers (Config 5 min; Own data 60 s), §C3 key factory, §C4 "migrate the raw-fetch pages" (the `profile-form-page` half: network config `:106/:140` and edit-mode item lookup `:171/:229`, plus the create-mode domain-lock probe). Phases 1, 2a, 2b-i, 2b-ii are done, reviewed, and pushed on this branch. **Remaining Part C after this:** 2b-iv (`home-page` migration + invalidate-on-write + `cache_ttl_seconds` — the coupled, highest-risk slice), 2b-v (§8 instance-URL cache-busting).

**Out of scope (do NOT do here):** invalidate-on-write on create/edit (that is 2b-iv §C5 — this plan only reads); passing `cache_ttl_seconds` (2b-iv §C6, browse feed only); §8 `selectedApiUrl`/instance-URL busting beyond the `apiBaseUrl` axis already baked into `resolvedNetwork(...)` keys here (2b-v wires the clear-on-switch); any change to `home-page.tsx`, `tourist-app.tsx`, browse feed, or markers.

## Global Constraints

- **Branch:** all work lands on `feat/ui-caching-strategy`. Do NOT commit to `feature`/`develop` without explicit confirmation.
- **ESM only, strict TS, no `any`.** UI filenames kebab-case. No `// TODO` comments (open an issue instead). No `console.log` in library code (existing `console.error` calls in the page are pre-existing and stay unless a step removes their effect).
- **staleTime tiers (spec §C2):** Config-like data (network config, resolved network) → **`5 * 60 * 1000`** (5 min). The user's own data (my items, edit-mode item) → **`60 * 1000`** (60 s). Do not invent other values.
- **Query keys come only from `lib/query-keys.ts`.** No inlined ad-hoc key arrays in the page or hooks except the disabled-sentinel form used by the existing `useNetworkConfig` (`['network-config', null]`) — mirror that exact style for new nullable keys.
- **Preserve behavior exactly.** The migration is a refactor: same screens, same loading/empty/not-found/error states, same navigation and toasts. A cache miss must never change correctness — every read already tolerates a re-fetch.
- **queryFn purity:** query functions fetch data and return it (or `null`); they never call `setState`, `navigate`, or `toast`. Side effects react to query state in `useEffect`.
- **AbortSignal:** forward React Query's `queryFn` `signal` into `fetchItems(query, signal)` so in-flight requests are cancelled on key change/unmount, preserving the current `AbortController` behavior.

## File Structure

- `apps/ui/src/lib/query-keys.ts` — **modify**: add `networkConfigs()`, `resolvedNetwork(networkId, apiBaseUrl)`, `editItem(networkId, itemId)`.
- `apps/ui/src/lib/query-keys.test.ts` — **modify**: assert the three new key values.
- `apps/ui/src/hooks/use-network-config.ts` — **modify**: add `useNetworkConfigs()` (list) and `useResolvedNetwork(networkId)` (fetch + `$ref` resolve, composed on `useNetworkConfig`).
- `apps/ui/src/hooks/use-network-config.test.tsx` — **create**: unit tests for the two new hooks.
- `apps/ui/src/hooks/use-my-items.ts` — **create**: `useMyItems(network)` — my items across the network's domains (create-mode domain lock; reused by 2b-iv).
- `apps/ui/src/hooks/use-my-items.test.tsx` — **create**.
- `apps/ui/src/hooks/use-edit-item.ts` — **create**: `useEditItem(network, itemId)` — locate an item by id across the network's domains for the edit form.
- `apps/ui/src/hooks/use-edit-item.test.tsx` — **create**.
- `apps/ui/src/pages/profile-form-page.tsx` — **modify**: replace the four fetch effects + the fetching state with the hooks and derived state.

---

### Task 1: Extend the query-key factory

**Files:**
- Modify: `apps/ui/src/lib/query-keys.ts`
- Modify: `apps/ui/src/lib/query-keys.test.ts`

**Interfaces:**
- Produces:
  - `queryKeys.networkConfigs(): readonly ['network-configs']`
  - `queryKeys.resolvedNetwork(networkId: string, apiBaseUrl: string): readonly ['resolved-network', string, string]`
  - `queryKeys.editItem(networkId: string, itemId: string): readonly ['edit-item', string, string]`
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

In `apps/ui/src/lib/query-keys.test.ts`, add this `it` block inside the existing `describe('queryKeys', ...)`:

```ts
  it('defines the profile-form keys (2b-iii)', () => {
    expect(queryKeys.networkConfigs()).toEqual(['network-configs']);
    expect(queryKeys.resolvedNetwork('blue_dot', 'https://api.example')).toEqual([
      'resolved-network',
      'blue_dot',
      'https://api.example',
    ]);
    expect(queryKeys.editItem('blue_dot', 'item-123')).toEqual(['edit-item', 'blue_dot', 'item-123']);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/lib/query-keys.test.ts`
Expected: FAIL — `queryKeys.networkConfigs is not a function`.

- [ ] **Step 3: Add the keys to the factory**

In `apps/ui/src/lib/query-keys.ts`, add three entries to the `queryKeys` object (after `networkConfig`, keeping `actions`/`myItems`/`browseItems`/`markers` as-is):

```ts
export const queryKeys = {
  networkConfig: (networkId: string) => ['network-config', networkId] as const,
  // The full list of network configs (GET /network/schemas, no `network` param).
  networkConfigs: () => ['network-configs'] as const,
  // Network config with all `$ref`s resolved against a given API base URL. The
  // base URL is part of the key so switching instance (§8, Plan 2b-v) yields a
  // distinct entry rather than serving a resolution built against the old host.
  resolvedNetwork: (networkId: string, apiBaseUrl: string) =>
    ['resolved-network', networkId, apiBaseUrl] as const,
  // A single item located by id (edit form), scoped to its network.
  editItem: (networkId: string, itemId: string) =>
    ['edit-item', networkId, itemId] as const,
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/lib/query-keys.test.ts`
Expected: PASS (all key tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/query-keys.ts apps/ui/src/lib/query-keys.test.ts
git commit -m "feat(ui): add networkConfigs/resolvedNetwork/editItem query keys

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `useNetworkConfigs` + `useResolvedNetwork` hooks

**Files:**
- Modify: `apps/ui/src/hooks/use-network-config.ts`
- Create: `apps/ui/src/hooks/use-network-config.test.tsx`

**Interfaces:**
- Consumes: `queryKeys.networkConfigs`, `queryKeys.resolvedNetwork` (Task 1); existing `useNetworkConfig(networkId)`; `fetchNetworkConfigs` from `@/lib/network-api`; `resolveNetworkRefs` from `@/engine/schema/resolve-schema`; `apiConfig` from `@/lib/api-config`.
- Produces:
  - `useNetworkConfigs(): { data: DotNetworkSchema[] | null; isLoading: boolean; isError: boolean }`
  - `useResolvedNetwork(networkId: string | null): { data: DotNetworkSchema | null; isLoading: boolean; isError: boolean }`

- [ ] **Step 1: Write the failing tests**

Create `apps/ui/src/hooks/use-network-config.test.tsx`:

```tsx
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import { useNetworkConfigs, useResolvedNetwork } from './use-network-config';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkConfigs: vi.fn(),
  fetchNetworkConfig: vi.fn(),
}));
import { fetchNetworkConfigs, fetchNetworkConfig } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const cfg = (id: string): DotNetworkSchema =>
  ({ id, domains: [] } as unknown as DotNetworkSchema);

describe('useNetworkConfigs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the fetched network configs', async () => {
    vi.mocked(fetchNetworkConfigs).mockResolvedValue([cfg('blue_dot'), cfg('yellow_dot')]);
    const { result } = renderHook(() => useNetworkConfigs(), { wrapper });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.map((n) => n.id)).toEqual(['blue_dot', 'yellow_dot']);
  });
});

describe('useResolvedNetwork', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches the config then resolves it (identity when no $refs)', async () => {
    vi.mocked(fetchNetworkConfig).mockResolvedValue(cfg('blue_dot'));
    const { result } = renderHook(() => useResolvedNetwork('blue_dot'), { wrapper });
    await waitFor(() => expect(result.current.data).not.toBeNull());
    expect(result.current.data?.id).toBe('blue_dot');
    expect(fetchNetworkConfig).toHaveBeenCalledWith('blue_dot');
  });

  it('is disabled for a null networkId (no fetch)', () => {
    renderHook(() => useResolvedNetwork(null), { wrapper });
    expect(fetchNetworkConfig).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter ui exec vitest run src/hooks/use-network-config.test.tsx`
Expected: FAIL — `useNetworkConfigs`/`useResolvedNetwork` are not exported yet.

- [ ] **Step 3: Add the two hooks**

In `apps/ui/src/hooks/use-network-config.ts`, add imports and the two hooks. The full file becomes:

```ts
import { useQuery } from '@tanstack/react-query';
import { fetchNetworkConfig, fetchNetworkConfigs } from '@/lib/network-api';
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import { apiConfig } from '@/lib/api-config';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

interface UseNetworkConfigResult {
  data: DotNetworkSchema | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
}

/**
 * Hook to fetch and cache a specific network configuration
 * @param networkId - The id of the network to fetch
 * @returns Network config data and query state
 */
export function useNetworkConfig(networkId: string | null): UseNetworkConfigResult {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: networkId ? queryKeys.networkConfig(networkId) : ['network-config', null],
    queryFn: async () => {
      if (!networkId) return null;
      return fetchNetworkConfig(networkId);
    },
    enabled: !!networkId,
    staleTime: 5 * 60 * 1000, // 5 minutes cache
  });

  return {
    data: data ?? null,
    isLoading,
    isError,
    error: error ?? null,
  };
}

interface UseNetworkConfigsResult {
  data: DotNetworkSchema[] | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Hook to fetch and cache the full list of network configs (used to discover
 * which networks a deployment serves). Config tier: 5-minute staleTime.
 */
export function useNetworkConfigs(): UseNetworkConfigsResult {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.networkConfigs(),
    queryFn: fetchNetworkConfigs,
    staleTime: 5 * 60 * 1000,
  });
  return { data: data ?? null, isLoading, isError };
}

interface UseResolvedNetworkResult {
  data: DotNetworkSchema | null;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Hook to fetch a network config and resolve its `$ref`s. Composes
 * `useNetworkConfig` (so the raw config shares the cache with other consumers,
 * e.g. action components) and caches the resolved result under a key that
 * includes the API base URL (so an instance switch re-resolves). Config tier.
 */
export function useResolvedNetwork(networkId: string | null): UseResolvedNetworkResult {
  const {
    data: rawConfig,
    isLoading: rawLoading,
    isError: rawError,
  } = useNetworkConfig(networkId);
  const apiBaseUrl = apiConfig.getUrl();

  const { data, isLoading, isError } = useQuery({
    queryKey:
      networkId != null
        ? queryKeys.resolvedNetwork(networkId, apiBaseUrl)
        : ['resolved-network', null, apiBaseUrl],
    queryFn: async () => {
      if (!rawConfig) return null;
      const resolved = await resolveNetworkRefs(rawConfig, { baseUrl: apiBaseUrl });
      return resolved as DotNetworkSchema;
    },
    enabled: !!rawConfig,
    staleTime: 5 * 60 * 1000,
  });

  return {
    data: data ?? null,
    // Loading while the raw config loads, or while resolution runs after it.
    isLoading: rawLoading || (!!rawConfig && isLoading),
    isError: rawError || isError,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter ui exec vitest run src/hooks/use-network-config.test.tsx`
Expected: PASS (3 tests green).

- [ ] **Step 5: Verify no regression**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/hooks/use-network-config.ts apps/ui/src/hooks/use-network-config.test.tsx
git commit -m "feat(ui): add useNetworkConfigs and useResolvedNetwork hooks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: `useMyItems` hook

**Files:**
- Create: `apps/ui/src/hooks/use-my-items.ts`
- Create: `apps/ui/src/hooks/use-my-items.test.tsx`

**Interfaces:**
- Consumes: `queryKeys.myItems` (existing); `fetchItems`, `Item` from `@/lib/item-api`; `useAuth` from `@/contexts/auth-context`; `DotNetworkSchema` from `@/engine/types`.
- Produces: `useMyItems(network: DotNetworkSchema | null): { data: Item[]; isLoading: boolean }` — fetches `created_by_me` items across every domain in `network` (limit 100 each) and flattens them. Disabled when `network` is null or the user is unauthenticated. Own-data tier (60 s).

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/hooks/use-my-items.test.tsx`:

```tsx
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useMyItems } from './use-my-items';

vi.mock('@/lib/item-api', () => ({ fetchItems: vi.fn() }));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
import { fetchItems } from '@/lib/item-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const item = (id: string, domain: string): Item =>
  ({ item_id: id, item_domain: domain } as unknown as Item);

const network = {
  id: 'blue_dot',
  domains: [
    { id: 'student', item_schemas: { 'profile_1.0': {} } },
    { id: 'mentor', item_schemas: { 'profile_1.0': {} } },
  ],
} as unknown as DotNetworkSchema;

describe('useMyItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('flattens my items across the network domains', async () => {
    vi.mocked(fetchItems).mockImplementation(async (q) => ({
      meta: { total: 0, limit: 100, offset: 0 },
      items: q.item_domain === 'student' ? [item('a', 'student')] : [item('b', 'mentor')],
    }));
    const { result } = renderHook(() => useMyItems(network), { wrapper });
    await waitFor(() => expect(result.current.data.length).toBe(2));
    expect(result.current.data.map((i) => i.item_id).sort()).toEqual(['a', 'b']);
    expect(fetchItems).toHaveBeenCalledWith(
      expect.objectContaining({ created_by_me: true, limit: 100 }),
      expect.anything(),
    );
  });

  it('is disabled (no fetch) when network is null', () => {
    renderHook(() => useMyItems(null), { wrapper });
    expect(fetchItems).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/hooks/use-my-items.test.tsx`
Expected: FAIL — `use-my-items` module does not exist.

- [ ] **Step 3: Implement the hook**

Create `apps/ui/src/hooks/use-my-items.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { fetchItems, type Item } from '@/lib/item-api';
import { useAuth } from '@/contexts/auth-context';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

interface UseMyItemsResult {
  data: Item[];
  isLoading: boolean;
}

/**
 * Fetch the current user's items (`created_by_me`) across every domain of a
 * network and flatten them. Used by the profile form's single-domain lock and
 * (Plan 2b-iv) the home-page "my profiles" list. Own-data tier: 60 s staleTime;
 * invalidate-on-write is wired in 2b-iv. A per-domain fetch that rejects
 * contributes an empty list (a partial failure never fails the whole query),
 * matching the page's prior `.catch(() => [])` behavior.
 */
export function useMyItems(network: DotNetworkSchema | null): UseMyItemsResult {
  const { user } = useAuth();

  const { data, isLoading } = useQuery({
    queryKey: network ? queryKeys.myItems(network.id) : ['my-items', null],
    queryFn: async ({ signal }) => {
      if (!network) return [];
      const results = await Promise.all(
        (network.domains ?? []).map((domain) => {
          const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
          const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
          return fetchItems(
            {
              item_network: network.id,
              item_domain: domain.id,
              item_type: itemType,
              created_by_me: true,
              limit: 100,
            },
            signal,
          )
            .then((res) => res.items)
            .catch(() => [] as Item[]);
        }),
      );
      return results.flat();
    },
    enabled: !!network && !!user,
    staleTime: 60 * 1000,
  });

  return { data: data ?? [], isLoading };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/hooks/use-my-items.test.tsx`
Expected: PASS (2 tests green).

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add apps/ui/src/hooks/use-my-items.ts apps/ui/src/hooks/use-my-items.test.tsx
git commit -m "feat(ui): add useMyItems hook (my items across network domains)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `useEditItem` hook

**Files:**
- Create: `apps/ui/src/hooks/use-edit-item.ts`
- Create: `apps/ui/src/hooks/use-edit-item.test.tsx`

**Interfaces:**
- Consumes: `queryKeys.editItem` (Task 1); `fetchItems`, `Item` from `@/lib/item-api`; `DotNetworkSchema` from `@/engine/types`.
- Produces: `useEditItem(network: DotNetworkSchema | null, itemId: string | null): { data: Item | null | undefined; isPending: boolean; isSuccess: boolean; isError: boolean }` — searches the network's domains in order for `item_id === itemId`, returns the first match, or `null` when the search completes with no match. Disabled (never fetches) when `network` or `itemId` is null. Own-data tier (60 s).

> Return-value contract for the consumer: `undefined` = not loaded yet (query disabled or in flight); `null` = loaded, item not found; `Item` = found. The page distinguishes not-found from not-loaded via `isSuccess && data === null`.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/hooks/use-edit-item.test.tsx`:

```tsx
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useEditItem } from './use-edit-item';

vi.mock('@/lib/item-api', () => ({ fetchItems: vi.fn() }));
import { fetchItems } from '@/lib/item-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const item = (id: string, domain: string): Item =>
  ({ item_id: id, item_domain: domain, item_state: {} } as unknown as Item);

const network = {
  id: 'blue_dot',
  domains: [
    { id: 'student', item_schemas: { 'profile_1.0': {} } },
    { id: 'mentor', item_schemas: { 'profile_1.0': {} } },
  ],
} as unknown as DotNetworkSchema;

describe('useEditItem', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the first matching item found across domains', async () => {
    vi.mocked(fetchItems).mockImplementation(async (q) => ({
      meta: { total: 0, limit: 1, offset: 0 },
      items: q.item_domain === 'mentor' ? [item('x', 'mentor')] : [],
    }));
    const { result } = renderHook(() => useEditItem(network, 'x'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.item_id).toBe('x');
  });

  it('returns null when no domain has the item', async () => {
    vi.mocked(fetchItems).mockResolvedValue({ meta: { total: 0, limit: 1, offset: 0 }, items: [] });
    const { result } = renderHook(() => useEditItem(network, 'missing'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });

  it('is disabled (no fetch) when itemId is null', () => {
    renderHook(() => useEditItem(network, null), { wrapper });
    expect(fetchItems).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/hooks/use-edit-item.test.tsx`
Expected: FAIL — `use-edit-item` module does not exist.

- [ ] **Step 3: Implement the hook**

Create `apps/ui/src/hooks/use-edit-item.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { fetchItems, type Item } from '@/lib/item-api';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

/**
 * Locate a single item by id for the edit form. The item's domain is unknown
 * up front, so we probe the network's domains in order and return the first
 * match. Returns `null` when the search finishes with no match (distinct from
 * `undefined` = not loaded), so the caller can redirect on a genuine miss.
 * Own-data tier: 60 s staleTime.
 */
export function useEditItem(network: DotNetworkSchema | null, itemId: string | null) {
  return useQuery({
    queryKey:
      network && itemId
        ? queryKeys.editItem(network.id, itemId)
        : ['edit-item', null],
    queryFn: async ({ signal }): Promise<Item | null> => {
      if (!network || !itemId) return null;
      for (const domain of network.domains ?? []) {
        const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
        const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
        const response = await fetchItems(
          {
            item_network: network.id,
            item_domain: domain.id,
            item_type: itemType,
            item_id: itemId,
            limit: 1,
          },
          signal,
        );
        if (response.items.length > 0) return response.items[0];
      }
      return null;
    },
    enabled: !!network && !!itemId,
    staleTime: 60 * 1000,
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/hooks/use-edit-item.test.tsx`
Expected: PASS (3 tests green).

- [ ] **Step 5: Verify + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add apps/ui/src/hooks/use-edit-item.ts apps/ui/src/hooks/use-edit-item.test.tsx
git commit -m "feat(ui): add useEditItem hook (locate item by id across domains)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Migrate `profile-form-page.tsx` to the hooks

This task replaces the four raw fetch effects and their backing `useState` with the Task 2–4 hooks and derived state. It is one atomic deliverable: the page must typecheck and the full UI suite must pass at the end (a half-migrated page has no clean test cycle). Work the sub-steps in order.

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx`

**Interfaces:**
- Consumes: `useNetworkConfigs`, `useResolvedNetwork` (`@/hooks/use-network-config`); `useMyItems` (`@/hooks/use-my-items`); `useEditItem` (`@/hooks/use-edit-item`).
- Produces: no new exports; the page's public component `ProfileFormPage` is unchanged.

**Behavior that must be preserved (checklist for the reviewer):**
- Networks list loads → `availableNetworkIds` (filtered by `VITE_NETWORK_ID`); on error → `[]`.
- `targetNetworkId` derivation unchanged (served scope → URL param → first available).
- Resolved network config drives `network`/`domains`; single-served-domain and locked-domain picker logic unchanged.
- Edit mode: item fetched by id across domains → seeds `existingItem`, `selectedDomain`, `initialData`; not-found → toast + redirect; load error → toast.
- Loading screen shows while networks list is loading, or (edit mode) while the item is loading; text is "loading profile" in edit-loading, "loading schemas" otherwise.
- `handleSubmit`, wallet import, consent, and all render markup are untouched.

- [ ] **Step 1: Swap imports**

In `apps/ui/src/pages/profile-form-page.tsx`, add the hook imports (near the other `@/hooks` import):

```ts
import { useNetworkConfigs, useResolvedNetwork } from '@/hooks/use-network-config';
import { useMyItems } from '@/hooks/use-my-items';
import { useEditItem } from '@/hooks/use-edit-item';
```

Remove the now-unused imports that were only used by the deleted effects:

```ts
// DELETE these lines:
import { resolveNetworkRefs } from '@/engine/schema/resolve-schema';
import { fetchNetworkConfig, fetchNetworkConfigs } from '@/lib/network-api';
import { apiConfig } from '@/lib/api-config';
```

From the `@/lib/item-api` import block, remove `fetchItems` (keep `createItem`, `updateItem`, and the types `CreateItemPayload`, `UpdateItemPayload`, `Item`):

```ts
import {
  createItem,
  updateItem,
  type CreateItemPayload,
  type UpdateItemPayload,
  type Item,
} from '@/lib/item-api';
```

> `DotNetworkSchema` (imported at the top as `import type { DotNetworkSchema } from '@/engine/types';`) is no longer referenced by the page after this migration (the `resolvedNetwork` state that used it is removed). Leave the import for now; Step 8's `pnpm typecheck` will flag it if unused — remove it then. Do NOT remove `GeoComponents`, `Item`, or any other type still used by `handleSubmit`/render.

- [ ] **Step 2: Replace the fetching `useState` with hook-derived state**

Delete these four state declarations (currently around lines 70–76):

```ts
// DELETE:
const [myItems, setMyItems] = React.useState<Item[]>([]);
const [resolvedNetwork, setResolvedNetwork] = React.useState<DotNetworkSchema | null>(null);
const [isLoading, setIsLoading] = React.useState(isEdit);
const [availableNetworkIds, setAvailableNetworkIds] = React.useState<string[] | null>(null);
```

Keep `existingItem`, `initialData`, `isSubmitting`, `isWalletModalOpen`, `formError`, `resolvedLocations`, `formValid`, `consentChecked`, and `selectedDomain` exactly as they are.

- [ ] **Step 3: Replace the networks-list effect (lines ~103–122) with the hook + derived `availableNetworkIds`**

Delete the entire `React.useEffect` that calls `fetchNetworkConfigs()` (the block starting `const controller = new AbortController();` through `return () => { controller.abort(); };`, lines ~103–122).

Immediately after the existing `configuredNetworkIds`/`networkFromUrl` memos, insert:

```ts
  // Networks list (config tier) — discover which network ids are available.
  const {
    data: networksData,
    isError: networksError,
  } = useNetworkConfigs();

  const availableNetworkIds = React.useMemo<string[] | null>(() => {
    if (networksError) return [];
    if (!networksData) return null;
    const filtered =
      configuredNetworkIds.length > 0
        ? networksData.filter((network) => configuredNetworkIds.includes(network.id))
        : networksData;
    return filtered.map((network) => network.id);
  }, [networksData, networksError, configuredNetworkIds]);
```

The existing `targetNetworkId` memo (lines ~124–131) stays unchanged — it already reads `availableNetworkIds`.

- [ ] **Step 4: Replace the config-fetch-and-resolve effect (lines ~134–155) with `useResolvedNetwork`**

Delete the entire `React.useEffect` that calls `fetchNetworkConfig(targetNetworkId)` then `resolveNetworkRefs(...)` (lines ~134–155, including its `setResolvedNetwork(null)` and `AbortController`).

Replace it (and the later `const network = resolvedNetwork;` / `const domains = network?.domains ?? [];` at lines ~212–213) with a single block placed right after the `targetNetworkId` memo:

```ts
  // Resolved network config (config tier) — fetch + $ref resolution, cached.
  const { data: resolvedNetwork } = useResolvedNetwork(targetNetworkId);
  const network = resolvedNetwork;
  const domains = network?.domains ?? [];
```

> Remove the old standalone `const network = resolvedNetwork;` and `const domains = network?.domains ?? [];` lines (~212–213) so they are not declared twice.

- [ ] **Step 5: Replace the domain-lock probe effect (lines ~220–246) with `useMyItems`**

Delete the entire `React.useEffect` that builds `Promise.all(... fetchItems ...)` and calls `setMyItems(...)` (lines ~220–246).

Add, alongside the other hook calls (after the `resolvedNetwork` block from Step 4):

```ts
  // My items across served domains (create mode only) → single-domain lock.
  // Edit mode reads the domain off the existing item, so skip the probe there.
  const { data: myItems } = useMyItems(isEdit ? null : network);
```

The `lockedDomain` memo (`myItems.length > 0 ? myItems[0].item_domain : null`) and `selectableDomains` memo are unchanged — they already read `myItems`.

- [ ] **Step 6: Replace the edit-mode item-load effect (lines ~158–210) with `useEditItem` + a seeding effect**

Delete the entire `React.useEffect` that defines `loadExistingProfile` and loops `fetchItems` (lines ~158–210).

Add the hook next to the others (after the `myItems` line from Step 5):

```ts
  // Existing profile for edit mode.
  const editItem = useEditItem(network, isEdit ? (id ?? null) : null);
```

Then add a seeding effect (place it where the deleted effect was). It reacts to the query result — no fetching, only state/navigation/toast:

```ts
  // Seed the edit form from the fetched item; redirect on a genuine miss.
  React.useEffect(() => {
    if (!isEdit) return;
    if (editItem.data) {
      setExistingItem(editItem.data);
      setSelectedDomain(editItem.data.item_domain);
      setInitialData(editItem.data.item_state);
    } else if (editItem.isSuccess && editItem.data === null) {
      toast.error(t('home.toast_profile_not_found'), {
        description: t('profile.toast_not_found_desc'),
      });
      navigate(`/?network=${resolvedNetwork?.id ?? ''}`);
    } else if (editItem.isError) {
      console.error('Failed to load profile:', editItem.error);
      toast.error(t('profile.toast_load_error'), {
        description: t('profile.toast_load_error_desc'),
      });
    }
  }, [
    isEdit,
    editItem.data,
    editItem.isSuccess,
    editItem.isError,
    editItem.error,
    resolvedNetwork?.id,
    navigate,
    t,
  ]);
```

- [ ] **Step 7: Derive the loading gate and update the render guard**

Add a derived loading flag next to the hook calls (after the `editItem` line):

```ts
  // Edit-mode loading: the network is resolved but the item is still in flight.
  // Create mode never shows the "loading profile" screen (the network guards
  // below cover the not-yet-ready cases). Matches the prior `isLoading` state,
  // which was seeded to `isEdit` and only cleared once the item load settled.
  const editLoading = isEdit && !!resolvedNetwork && editItem.isPending;
```

Update the first render guard (currently `if (availableNetworkIds === null || isLoading)`, lines ~480–488) to use `editLoading`:

```ts
  if (availableNetworkIds === null || editLoading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <p className="text-muted-foreground">
          {editLoading ? t('profile.loading_profile') : t('profile.loading_schemas')}
        </p>
      </div>
    );
  }
```

The remaining guards (`!targetNetworkId` → "no networks", `!network` → "loading schemas") are unchanged.

- [ ] **Step 8: Typecheck and fix any unused-symbol fallout**

Run: `pnpm typecheck`
Expected: PASS. If it reports `DotNetworkSchema` (or any other symbol) is declared-but-unused, remove that import line. If it reports a symbol IS still used, keep it. Re-run until clean.

- [ ] **Step 9: Run the full UI test suite**

Run: `pnpm --filter ui test`
Expected: PASS — full UI suite green. No existing test asserts the removed internal `useState`/effect behavior; the page renders the same screens from query-derived state.

- [ ] **Step 10: Manual smoke test (real app)**

Use the `run-signals-dpg` skill to bring the stack up locally, then verify by hand:
1. **Create flow:** open the create-profile page → role picker (or auto-selected single/locked domain) renders; the form loads its schema.
2. **Edit flow:** open an existing profile's edit URL (`/profile/:id`) → the "loading profile" screen shows briefly, then the form is pre-filled with the item's `item_state` and the correct domain.
3. **Not-found:** open `/profile/<bogus-id>` → "profile not found" toast + redirect to home.
4. **Caching:** navigate away from and back to the create page within a few seconds → no second `/network/schemas` request in the Network tab (served from React Query cache; watch for `network-config`/`network-configs`).

Record the result (what you drove, what you observed) in the SDD ledger. If any step regresses, stop and debug before committing.

- [ ] **Step 11: Commit**

```bash
git add apps/ui/src/pages/profile-form-page.tsx
git commit -m "feat(ui): migrate profile-form-page fetches to React Query

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (Part C, profile-form-page slice):**
- §C2 Config tier (5 min) → `useNetworkConfigs`, `useResolvedNetwork` (Tasks 2, 5). Own-data tier (60 s) → `useMyItems`, `useEditItem` (Tasks 3, 4).
- §C3 key factory → Task 1 adds `networkConfigs`/`resolvedNetwork`/`editItem`; every hook keys through `queryKeys`. The `apiBaseUrl` axis on `resolvedNetwork` is the flag-back for §8/2b-v.
- §C4 "migrate the raw-fetch pages" (profile-form-page: network config `:106/:140`, edit lookup `:171/:229`, plus the domain-lock probe) → Task 5 replaces all four effects. "Reuse `useNetworkConfig`/`useConsentConfig`" → `useResolvedNetwork` composes `useNetworkConfig`; `useConsentConfig` was already in use.
- §C5 invalidate-on-write and §C6 `cache_ttl_seconds` are explicitly deferred to 2b-iv (stated in scope) — this page only reads, and none of its reads are the browse feed.

**Placeholder scan:** none. Every code step shows full code; every command has expected output. The one conditional instruction (Step 8 unused-import removal) is grounded in a concrete typecheck signal, not a guess. Line numbers are written as approximate (`~`) because earlier steps shift them; each deletion is identified by its distinctive content, not line number alone.

**Type consistency:**
- `useNetworkConfigs(): { data: DotNetworkSchema[] | null; isLoading; isError }` — page reads `data` as `networksData` and `isError` as `networksError`. ✓
- `useResolvedNetwork(networkId): { data: DotNetworkSchema | null; ... }` — page binds `data` to `resolvedNetwork`; `network`/`domains` derive from it. ✓
- `useMyItems(network): { data: Item[]; isLoading }` — page binds `data` to `myItems: Item[]`; `lockedDomain`/`selectableDomains` consume `Item[]`. ✓
- `useEditItem(network, itemId)` returns the raw `useQuery` result; page uses `.data` (`Item | null | undefined`), `.isSuccess`, `.isError`, `.error`, `.isPending`. The `null` vs `undefined` contract is documented and the seeding effect branches on `isSuccess && data === null`. ✓
- Key values: `resolvedNetwork(id, baseUrl)` and `editItem(id, itemId)` are used with matching arity in the hooks and asserted in Task 1's test. ✓

**Behavior check:** loading text — `editLoading` true ⇒ "loading profile" (was `isLoading` true in edit), else "loading schemas" (was `isLoading` false); `availableNetworkIds === null` still gates on the networks list. Networks error path yields `[]` (was `setAvailableNetworkIds([])`). Partial per-domain fetch failure in `useMyItems` still degrades to `[]` (was `.catch(() => [])`). queryFn purity preserved — all `setState`/`navigate`/`toast` live in the Step 6 effect. AbortController behavior preserved via forwarded `signal`.

## Notes for later Part-C plans
- **2b-iv (`home-page.tsx`)** — reuse `useResolvedNetwork` (config `:250/:287`) and `useMyItems` (my-profiles `:338`) from this plan; recompute `activeProfileId`/`consentedProfileIds`/`profilesResolved` from query data. Add the browse-feed `useQuery` (`queryKeys.browseItems`, ~90 s tier) passing `cache_ttl_seconds` (§C6). Add invalidate-on-write (§C5): `createItem`/`updateItem` → invalidate `queryKeys.myItems` (+ relevant `browseItems`); `performAction(s)` → invalidate `queryKeys.actions.all`; consent-accept → invalidate instead of the local `Set`. **Key-collision guard:** `useMyItems` keys on `queryKeys.myItems(networkId)` — if home-page's my-profiles fetches the same "my items in this network" data, reuse `useMyItems` verbatim (do NOT define a second query under the same key with a different queryFn/shape).
- **2b-v (§8 instance-URL busting)** — `resolvedNetwork(networkId, apiBaseUrl)` already varies by API base URL, so an instance switch produces a fresh resolution key. Extend the same axis to `browseItems`/`myItems`/`markers`/schema keys and clear caches on `apiConfig.setSelectedKey` (since `createApiClient` captures `baseURL` at construction).
