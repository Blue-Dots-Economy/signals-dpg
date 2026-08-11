# #203 P3 — Distance Ordering + List Infinite Scroll + Truncation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver P3 of the #203 umbrella: server-side **distance ordering** for local item fetches, the **relaxed geo refinement** (lat+lng orderable without a radius), and the **list view on paged infinite-scroll** (nearest-first, page ~50) with a **truncation "X of Y" indicator** — replacing the single ~1000-row full pull for the list.

**Architecture:** The geo query itself is already verified correct (§4.0, `geosearch_radius.integration.test.ts`). This plan (1) adds an `ORDER BY nearest-location distance, then recency` to `fetchLocalItems` when lat/lng are present; (2) relaxes `withGeoSearchRefinement` so `lat+lng` is valid without `radius_meters` (order-only) while `radius` alone stays invalid; (3) plumbs `item_latitude`/`item_longitude` through the UI network-fetch; (4) adds a paged browse hook (React Query `useInfiniteQuery`) and moves the **list** view onto it. The **map** view keeps reading the existing full `useBrowseItems` fetch in P3 — it is decoupled onto the markers endpoint in **P4**; the transient duplication is intentional and resolved before the PR merges.

**Tech Stack:** Fastify + Drizzle + Postgres (`earthdistance`/`cube` extensions) on the server; React 19 + `@tanstack/react-query` v5 (`useInfiniteQuery`, `useQueries`) + Vitest on the client.

**Epic context:** P3 of #203 (`docs/superpowers/specs/2026-07-13-ui-data-fetching-at-scale-design.md`), spec §4.1, §4.2, §5.1, §6. §4.0 (verify existing geosearch) is DONE. Delivered on branch `feat/ui-caching-strategy` (PR #295) on top of the completed caching baseline. **P4** (markers endpoint §4.3–§4.5 + map viewport §5.2) and **P5** (cross-instance scatter-gather §4.4 + anon count-first §7 + full cache-key correctness §8) are separate later plans; **P6** relevance (§9) is cross-repo.

**Out of scope (do NOT do here):** the markers endpoint / map viewport fetch (P4); cross-instance ordering §4.4 — P3's ordering is correct for single-instance/local fetches and **degenerates cleanly** for multi-instance (which stays count-block-concatenated until P5, same as today); anonymous count-first §7; any instance-URL cache-busting §8.

## Global Constraints

- **Branch:** `feat/ui-caching-strategy` (PR #295). Do NOT commit to `feature`/`develop`.
- **Server:** ESM, strict TS, no `any`. Routes never throw. Reuse the existing `earthdistance` helpers (`ll_to_earth`, `earth_distance`) already used by `buildWhereClause`; do NOT introduce PostGIS.
- **UI:** ESM, strict TS, no `any`, kebab-case filenames, no `// TODO`. staleTime for the browse feed stays the **90s tier** (spec §C2); keep passing `cache_ttl_seconds`.
- **Distance-ordering semantics (spec §4.1), exact:** when `item_latitude` AND `item_longitude` are present → order by the **MIN** distance across the item's `item_locations`, `ASC NULLS LAST`, then `created_at DESC`. No-location items sort **last** then by recency. No coordinates → keep current `created_at DESC`. Filtering by radius is unchanged (only when `radius_meters` present).
- **Relaxed refinement (spec §4.2), exact:** `lat+lng` (no radius) → valid; `lat+lng+radius` → valid; `radius` without both lat and lng → **invalid**; a single one of lat/lng without the other → **invalid**. Applied to `FetchItemsQuerySchema`, `FetchItemsCountBodySchema`, `FetchItemsBodySchema`.
- **Page size:** `VITE_PROFILE_PAGE_SIZE`, default **50** (read via `import.meta.env`, validated like the existing `resolveProfileFetchLimit`).
- **Behavior preservation (list):** match-score cards, card selection, enum filters, actions, empty states, and the "All" vs single-domain split all keep working. Single-domain **trusts server order** (drop the client `sortByNearest` for that path); the "All" tab **retains** a client merge-sort of the loaded union (the server cannot order across domains in one query).
- **Truncation (spec §6):** the list shows a truthful "showing X of Y" from `meta.total`; a partial/federation-degraded result must never be presented (or cached) as complete. (`meta.partial` propagation is P5; in P3 surface `meta.total` vs loaded count.)

## File Structure

- `apps/api/src/utils/item_fetch_runtime.ts` — **modify**: conditional distance `ORDER BY` in `fetchLocalItems`.
- `apps/api/src/utils/__tests__/geosearch_radius.integration.test.ts` — **modify**: add §4.1 distance-ordering assertions (extends the §4.0 suite).
- `packages/schemas/src/api/item_schemas.ts` — **modify**: relax `withGeoSearchRefinement`.
- `packages/schemas/src/api/__tests__/item_schemas.test.ts` — **create/modify**: refinement unit tests (the four cases).
- `apps/ui/src/lib/network-api.ts` — **modify**: add `item_latitude`/`item_longitude`/`radius_meters` to `FetchNetworkItemsQuery` + serialize; add `resolveProfilePageSize()`.
- `apps/ui/src/hooks/use-infinite-browse-items.ts` — **create**: single-domain `useInfiniteQuery` paged hook.
- `apps/ui/src/hooks/use-infinite-browse-items.test.tsx` — **create**.
- `apps/ui/src/pages/home-page.tsx` — **modify**: list view → paged (single-domain + All-tab), truncation indicator, bottom-sentinel; keep map/enum/`useBrowseItems` intact.

---

### Task 1: §4.1 — distance ordering in `fetchLocalItems`

**Files:**
- Modify: `apps/api/src/utils/item_fetch_runtime.ts`
- Modify: `apps/api/src/utils/__tests__/geosearch_radius.integration.test.ts`

**Interfaces:**
- Produces: `fetchLocalItems(filters)` ordered nearest-first when `filters.item_latitude`/`item_longitude` are set; unchanged (`created_at DESC`) otherwise. Signature unchanged.

- [ ] **Step 1: Add the failing ordering assertions (integration, extends §4.0 suite)**

In `geosearch_radius.integration.test.ts`, add a test inside the existing `describeIf` block. It reuses the seeded rows (atCenter 0 m, near ~556 m, far ~5566 m):

```ts
    it('§4.1 orders nearest-first when lat/lng present (no radius = order-only), no-location last', async () => {
      const res = await fetchLocalItems({
        item_network: NET,
        item_domain: DOMAIN,
        item_type: TYPE,
        item_latitude: LAT,
        item_longitude: LNG,
        limit: 100,
        offset: 0,
      });
      const order = res.items.map((i) => i.item_id);
      // nearest-first among located items
      expect(order.indexOf(ids.atCenter)).toBeLessThan(order.indexOf(ids.near));
      expect(order.indexOf(ids.near)).toBeLessThan(order.indexOf(ids.far));
      // multiOneIn (nearest loc ~334 m) sorts ahead of near (~556 m)
      expect(order.indexOf(ids.multiOneIn)).toBeLessThan(order.indexOf(ids.near));
      // no-location item sorts LAST
      expect(order[order.length - 1]).toBe(ids.noLocations);
      // order-only: nothing filtered out (all 6 present)
      expect(res.items.length).toBe(6);
    });
```

- [ ] **Step 2: Run it — expect FAIL (current code orders by `created_at DESC` only)**

Run: `pnpm --filter api exec vitest run --config vitest.integration.config.ts src/utils/__tests__/geosearch_radius.integration.test.ts`
Expected: the new ordering test FAILS (rows come back in insertion/recency order, not distance order); the §4.0 filter tests still PASS.

- [ ] **Step 3: Add the conditional distance ORDER BY**

In `apps/api/src/utils/item_fetch_runtime.ts`, in `fetchLocalItems`, replace the fixed `.orderBy(sql`${items.created_at} DESC`)` with a computed clause. Insert before the `db.select(...)` call:

```ts
  const orderByClause =
    filters.item_latitude !== undefined && filters.item_longitude !== undefined
      ? sql`
          (
            SELECT MIN(
              earth_distance(
                ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
                ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)
              )
            )
            FROM jsonb_array_elements(${items.item_locations}) loc
          ) ASC NULLS LAST,
          ${items.created_at} DESC
        `
      : sql`${items.created_at} DESC`;
```

and use it:

```ts
  const result = await db
    .select(itemResponseColumns)
    .from(items)
    .where(whereClause)
    .orderBy(orderByClause)
    .limit(filters.limit)
    .offset(filters.offset);
```

> The subquery over an **empty** `item_locations` array yields `NULL` → `NULLS LAST` → no-location items sort last, then `created_at DESC`. This matches §4.1 exactly and requires no schema change.

- [ ] **Step 4: Run it — expect PASS**

Run: `pnpm --filter api exec vitest run --config vitest.integration.config.ts src/utils/__tests__/geosearch_radius.integration.test.ts`
Expected: all tests PASS (filter + ordering).

- [ ] **Step 5: Regression + commit**

Run: `pnpm --filter api test` (unit) → PASS. Run: `pnpm typecheck` → PASS.

```bash
git add apps/api/src/utils/item_fetch_runtime.ts apps/api/src/utils/__tests__/geosearch_radius.integration.test.ts
git commit -m "feat(api): distance-order local item fetch by nearest location (#203 §4.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: §4.2 — relax the geo refinement

**Files:**
- Modify: `packages/schemas/src/api/item_schemas.ts`
- Create: `packages/schemas/src/api/__tests__/item_schemas.test.ts` (or extend if present)

**Interfaces:**
- Produces: `FetchItemsQuerySchema`/`FetchItemsCountBodySchema`/`FetchItemsBodySchema` accept `lat+lng` without `radius_meters`; reject `radius` alone and a lone lat or lng.

- [ ] **Step 1: Write the failing tests**

Create `packages/schemas/src/api/__tests__/item_schemas.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { FetchItemsQuerySchema } from '../item_schemas';

const base = { item_network: 'n', item_domain: 'd' };

describe('FetchItemsQuerySchema geo refinement (§4.2)', () => {
  it('accepts no geo params', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base }).success).toBe(true);
  });
  it('accepts lat+lng without radius (order-only)', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, item_latitude: 19, item_longitude: 72 }).success).toBe(true);
  });
  it('accepts lat+lng+radius (filter+order)', () => {
    expect(
      FetchItemsQuerySchema.safeParse({ ...base, item_latitude: 19, item_longitude: 72, radius_meters: 1000 }).success,
    ).toBe(true);
  });
  it('rejects radius without lat/lng', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, radius_meters: 1000 }).success).toBe(false);
  });
  it('rejects a lone latitude', () => {
    expect(FetchItemsQuerySchema.safeParse({ ...base, item_latitude: 19 }).success).toBe(false);
  });
});
```

Run: `pnpm --filter @dpg/schemas exec vitest run src/api/__tests__/item_schemas.test.ts` (or the repo's schemas test command — check `packages/schemas/package.json`; if schemas has no vitest, run via `pnpm --filter api exec vitest run` against a copied path, but prefer the package's own test script).
Expected: "accepts lat+lng without radius" FAILS (current refinement requires radius); "rejects radius without lat/lng" already passes.

- [ ] **Step 2: Relax `withGeoSearchRefinement`**

In `packages/schemas/src/api/item_schemas.ts`, replace the body of the `.refine(...)` predicate in `withGeoSearchRefinement`:

```ts
function withGeoSearchRefinement<T extends z.ZodTypeAny>(schema: T) {
  return schema.refine(
    (rawData) => {
      const data = rawData as Partial<FetchItemsSchemaShape>;
      const hasLat = data.item_latitude !== undefined;
      const hasLng = data.item_longitude !== undefined;
      const hasRadius = data.radius_meters !== undefined;

      // lat/lng must be supplied as a pair.
      if (hasLat !== hasLng) return false;
      // radius filtering requires a center (lat+lng); radius alone is invalid.
      if (hasRadius && !(hasLat && hasLng)) return false;
      // lat+lng alone is valid (order-only); lat+lng+radius is valid (filter+order).
      return true;
    },
    {
      message:
        'item_latitude and item_longitude must be provided together; radius_meters requires both',
      path: ['radius_meters'],
    }
  );
}
```

- [ ] **Step 3: Run tests — expect PASS**

Run the schemas test again → all 5 PASS. Run: `pnpm typecheck` → PASS.

- [ ] **Step 4: Verify server still filters only when radius present**

Read `apps/api/src/utils/item_fetch_runtime.ts` `buildWhereClause` — the geo EXISTS/`earth_distance <= radius` block is gated on `radius_meters !== undefined` (unchanged), so `lat+lng` alone orders-without-filtering. No code change; note this in the commit body.

- [ ] **Step 5: Commit**

```bash
git add packages/schemas/src/api/item_schemas.ts packages/schemas/src/api/__tests__/item_schemas.test.ts
git commit -m "feat(schemas): allow lat+lng geosearch without a radius (order-only) (#203 §4.2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Plumb `item_latitude`/`item_longitude` through the UI network fetch + page-size env

**Files:**
- Modify: `apps/ui/src/lib/network-api.ts`

**Interfaces:**
- Produces:
  - `FetchNetworkItemsQuery` gains `item_latitude?: number; item_longitude?: number; radius_meters?: number`.
  - `fetchNetworkItems` serializes those params when set.
  - `resolveProfilePageSize(): number` (default 50 from `VITE_PROFILE_PAGE_SIZE`) + exported `PROFILE_PAGE_SIZE`.

- [ ] **Step 1: Extend the query type + serialization**

In `apps/ui/src/lib/network-api.ts`, extend `FetchNetworkItemsQuery`:

```ts
export interface FetchNetworkItemsQuery
  extends Omit<FetchItemsQuery, 'created_by_me'> {
  item_latitude?: number;
  item_longitude?: number;
  radius_meters?: number;
  cache_ttl_seconds?: number;
}
```

In `fetchNetworkItems`, after the `offset` param serialization, add:

```ts
  if (query.item_latitude !== undefined) {
    params.set('item_latitude', String(query.item_latitude));
  }
  if (query.item_longitude !== undefined) {
    params.set('item_longitude', String(query.item_longitude));
  }
  if (query.radius_meters !== undefined) {
    params.set('radius_meters', String(query.radius_meters));
  }
```

- [ ] **Step 2: Add `resolveProfilePageSize` (mirror `resolveProfileFetchLimit`)**

Below the existing `resolveProfileFetchLimit`/`PROFILE_FETCH_LIMIT`:

```ts
const DEFAULT_PROFILE_PAGE_SIZE = 50;

export function resolveProfilePageSize(): number {
  const raw = import.meta.env.VITE_PROFILE_PAGE_SIZE;
  if (raw === undefined || raw === '') return DEFAULT_PROFILE_PAGE_SIZE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_PROFILE_PAGE_SIZE;
  return parsed;
}

export const PROFILE_PAGE_SIZE = resolveProfilePageSize();
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck` → PASS. Run: `pnpm --filter ui test` → PASS (no consumer yet; additive).

```bash
git add apps/ui/src/lib/network-api.ts
git commit -m "feat(ui): send lat/lng to network fetch + VITE_PROFILE_PAGE_SIZE (#203 §5.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Paged browse hook — `useInfiniteBrowseItems`

**Files:**
- Create: `apps/ui/src/hooks/use-infinite-browse-items.ts`
- Create: `apps/ui/src/hooks/use-infinite-browse-items.test.tsx`

**Interfaces:**
- Produces: `useInfiniteBrowseItems(network, domain, userLocation, opts?)`:
  ```ts
  function useInfiniteBrowseItems(
    network: DotNetworkSchema | null,
    domain: DotNetworkDomain | null,
    userLocation: { lat: number; lng: number } | null,
    opts?: { enabled?: boolean },
  ): { items: Item[]; total: number; hasNextPage: boolean; isLoading: boolean; isFetchingNextPage: boolean; fetchNextPage: () => void };
  ```
- Consumes: `fetchNetworkItems`, `PROFILE_PAGE_SIZE` (Task 3); `queryKeys.browseItems`; `Item`, `DotNetworkSchema`, `DotNetworkDomain`.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/hooks/use-infinite-browse-items.test.tsx`:

```tsx
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useInfiniteBrowseItems } from './use-infinite-browse-items';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn(),
  PROFILE_PAGE_SIZE: 2,
}));
import { fetchNetworkItems } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
const item = (id: string): Item => ({ item_id: id } as unknown as Item);
const network = { id: 'blue_dot' } as unknown as DotNetworkSchema;
const domain = { id: 'student', item_schemas: { 'profile_1.0': {} } } as unknown as DotNetworkDomain;

describe('useInfiniteBrowseItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads pages, appends, exposes total + hasNextPage, sends lat/lng + offset', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async (q) => ({
      meta: { total: 3, limit: 2, offset: q.offset ?? 0 },
      items: (q.offset ?? 0) === 0 ? [item('a'), item('b')] : [item('c')],
    }));
    const { result } = renderHook(
      () => useInfiniteBrowseItems(network, domain, { lat: 19, lng: 72 }),
      { wrapper },
    );
    await waitFor(() => expect(result.current.items.length).toBe(2));
    expect(result.current.total).toBe(3);
    expect(result.current.hasNextPage).toBe(true);
    expect(fetchNetworkItems).toHaveBeenCalledWith(
      expect.objectContaining({ item_latitude: 19, item_longitude: 72, offset: 0 }),
      expect.anything(),
    );
    act(() => result.current.fetchNextPage());
    await waitFor(() => expect(result.current.items.map((i) => i.item_id)).toEqual(['a', 'b', 'c']));
    expect(result.current.hasNextPage).toBe(false); // 3 of 3 loaded
  });

  it('is disabled when domain is null (no fetch)', () => {
    renderHook(() => useInfiniteBrowseItems(network, null, null), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter ui exec vitest run src/hooks/use-infinite-browse-items.test.tsx` → FAIL (module missing).

- [ ] **Step 2: Implement the hook**

Create `apps/ui/src/hooks/use-infinite-browse-items.ts`:

```ts
import { useInfiniteQuery } from '@tanstack/react-query';
import { fetchNetworkItems, PROFILE_PAGE_SIZE } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

const BROWSE_STALE_TIME_MS = 90 * 1000;
const BROWSE_CACHE_TTL_SECONDS = 90;

interface UseInfiniteBrowseItemsResult {
  items: Item[];
  total: number;
  hasNextPage: boolean;
  isLoading: boolean;
  isFetchingNextPage: boolean;
  fetchNextPage: () => void;
}

/**
 * Paged browse feed for ONE domain (spec §5.1): server-ordered (nearest-first
 * when a location is supplied), page size VITE_PROFILE_PAGE_SIZE. The list view
 * consumes this; the map keeps its own fetch (decoupled in P4). Items are raw —
 * own-item filtering / enum filtering stay in the page's view layer.
 */
export function useInfiniteBrowseItems(
  network: DotNetworkSchema | null,
  domain: DotNetworkDomain | null,
  userLocation: { lat: number; lng: number } | null,
  opts?: { enabled?: boolean },
): UseInfiniteBrowseItemsResult {
  const itemTypeKeys = domain?.item_schemas ? Object.keys(domain.item_schemas) : [];
  const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
  const enabled = !!network && !!domain && (opts?.enabled ?? true);

  // Location is part of the key so a location change resets paging (spec §5.1).
  const filters = {
    limit: PROFILE_PAGE_SIZE,
    lat: userLocation?.lat ?? null,
    lng: userLocation?.lng ?? null,
  };

  const query = useInfiniteQuery({
    queryKey: network && domain ? queryKeys.browseItems(network.id, domain.id, filters) : ['browse-items', null],
    enabled,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) => {
      const res = await fetchNetworkItems(
        {
          item_network: network!.id,
          item_domain: domain!.id,
          item_type: itemType,
          limit: PROFILE_PAGE_SIZE,
          offset: pageParam,
          cache_ttl_seconds: BROWSE_CACHE_TTL_SECONDS,
          ...(userLocation
            ? { item_latitude: userLocation.lat, item_longitude: userLocation.lng }
            : {}),
        },
        signal,
      );
      return res;
    },
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((n, p) => n + p.items.length, 0);
      return loaded < lastPage.meta.total ? loaded : undefined;
    },
    staleTime: BROWSE_STALE_TIME_MS,
  });

  const items = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.meta.total ?? 0;

  return {
    items,
    total,
    hasNextPage: query.hasNextPage,
    isLoading: query.isLoading,
    isFetchingNextPage: query.isFetchingNextPage,
    fetchNextPage: () => {
      if (query.hasNextPage && !query.isFetchingNextPage) query.fetchNextPage();
    },
  };
}
```

Run the test → PASS. Run `pnpm typecheck` → PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/hooks/use-infinite-browse-items.ts apps/ui/src/hooks/use-infinite-browse-items.test.tsx
git commit -m "feat(ui): add useInfiniteBrowseItems paged browse hook (#203 §5.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Migrate the home-page LIST view to paged infinite scroll

This is the largest, highest-risk task. The list view has two branches — **single-domain** (`CardGrid`) and **"All" tab** (flat merged grid). The map view, enum filters (`filteredDomainItems`), match-score `fullItem` lookups, and card selection all currently read the full `domainItems` from `useBrowseItems`; **leave those untouched** (P4 decouples the map). Only the list rendering switches to the paged hook. Work the sub-steps in order; the page must typecheck and the full UI suite must stay green.

**Files:** Modify `apps/ui/src/pages/home-page.tsx`.

**Interfaces:** Consumes `useInfiniteBrowseItems` (Task 4). React hooks cannot be called in a loop, so:
- **Single-domain:** call `useInfiniteBrowseItems(network, selectedDomainObj, userLocation)` once.
- **"All" tab (multi-domain):** render a child component `<AllDomainsPagedList>` that maps each visible domain to its own `<DomainPagedList>` child which calls the hook — one hook per child component (legal). Each child renders its own cards; a shared "Load more" advances a lifted `pageBumpNonce`, OR each child owns its sentinel. **Design decision (flag for review):** to keep the merged nearest-first ordering across domains that §5.1 requires, `<AllDomainsPagedList>` collects each child's loaded items via a callback into parent state, then renders ONE merged, `sortItemsByNearest`-sorted grid; each child is headless (fetch-only). This preserves the cross-domain client merge-sort.

- [ ] **Step 1: Compute the selected domain object + userLocation coords**

Near the existing `domainsToFetch`/`domainItems` memos, add:

```ts
  const selectedDomainObj = React.useMemo(
    () => (selectedDomain ? (network?.domains.find((d) => d.id === selectedDomain) ?? null) : null),
    [network, selectedDomain],
  );
  // Coords for server ordering; omit when the source is 'none'.
  const browseCoords = React.useMemo(
    () => (userLocation ? { lat: userLocation.lat, lng: userLocation.lng } : null),
    [userLocation],
  );
```

- [ ] **Step 2: Single-domain paged fetch**

Add the single-domain hook call (enabled only when a specific domain is selected):

```ts
  const singleDomainList = useInfiniteBrowseItems(
    network,
    selectedDomain ? selectedDomainObj : null,
    browseCoords,
    { enabled: selectedDomain !== null },
  );
```

Replace the single-domain `CardGrid` branch's data source: use `singleDomainList.items` (enum-filtered inline) instead of `filteredDomainItems[selectedDomain]`, and **drop `sortByNearest`** for this path (server already orders):

```tsx
              <CardGrid
                schema={activeSchema!}
                schemaName={selectedDomain}
                schemaDescription={currentDomainLabel}
                cardConfig={network?.domains.find((d) => d.id === selectedDomain)?.card}
                items={applyEnumFilters(singleDomainList.items).map(toCardShape)}
                fullItems={singleDomainList.items}
                loading={singleDomainList.isLoading}
                actions={actions}
                /* ...unchanged action/selection props... */
              />
```

> `applyEnumFilters` + `toCardShape`: reuse the exact enum-filter predicate and `{ id, data }` mapping already applied when building `filteredDomainItems`/card items today (extract the existing inline logic into small local helpers so the paged path and the map path share one implementation — do NOT duplicate the predicate). The implementer must trace the current `filteredDomainItems` construction (home-page ~688–719) and reuse it.

- [ ] **Step 3: Bottom sentinel → next page (single-domain)**

Add an `IntersectionObserver` sentinel under the single-domain grid that calls `singleDomainList.fetchNextPage()` when visible. Reuse the existing `allCardsGridRef` pattern if present; otherwise a `useRef` + `useEffect` observer that disconnects on cleanup and is gated on `singleDomainList.hasNextPage`.

- [ ] **Step 4: "All" tab paged fetch (headless children + merged render)**

Extract the "All" tab body into a child component (same file or a colocated one) that fetches per domain via the hook and lifts loaded items up for a merged sort:

```tsx
function DomainPagedFetch({
  network, domain, coords, onItems,
}: {
  network: DotNetworkSchema; domain: DotNetworkDomain;
  coords: { lat: number; lng: number } | null;
  onItems: (domainId: string, items: Item[], hasMore: boolean, total: number, fetchNext: () => void) => void;
}) {
  const list = useInfiniteBrowseItems(network, domain, coords);
  React.useEffect(() => {
    onItems(domain.id, list.items, list.hasNextPage, list.total, list.fetchNextPage);
  }, [domain.id, list.items, list.hasNextPage, list.total, list.fetchNextPage, onItems]);
  return null; // headless
}
```

The "All" body renders one `DomainPagedFetch` per visible domain, accumulates `{ [domainId]: { items, hasMore, total, fetchNext } }` in state, then renders the SINGLE merged grid using the existing `sortItemsByNearest(allFlatItemsUnsorted, userLocation, ...)` logic (unchanged) over the accumulated union. "Load more" calls every domain's `fetchNext` whose `hasMore` is true. Truncation total = sum of per-domain totals.

> This preserves the current "All" tab UX (flat merged, nearest-first, match-score cards) while paging each domain server-side. Keep the `SelectableCard`/`MatchScoreCard` rendering and `fullItem` lookup exactly as today (the `fullItem` lookup may read the accumulated union instead of `domainItems`).

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `pnpm typecheck` → PASS. Run: `pnpm --filter ui test` → full UI suite green. Remove now-unused bits only if typecheck confirms (do NOT remove `useBrowseItems`/`domainItems` — the map + enum + filteredDomainItems still use them in P3).

```bash
git add apps/ui/src/pages/home-page.tsx
git commit -m "feat(ui): list view on paged infinite scroll, nearest-first (#203 §5.1)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: §6 — truncation "X of Y" indicator on the list

**Files:** Modify `apps/ui/src/pages/home-page.tsx`.

**Interfaces:** none new; renders `total` from the paged hooks.

- [ ] **Step 1: Surface the count**

Above each list grid (single-domain and "All"), render a small, translated indicator when `loaded < total`:

- Single-domain: `loaded = singleDomainList.items.length`, `total = singleDomainList.total`.
- "All" tab: `loaded = merged union length`, `total = sum of per-domain totals`.

```tsx
  {loadedCount < totalCount && (
    <p className="mb-2 text-xs text-muted-foreground">
      {t('home.showing_x_of_y', { shown: loadedCount, total: totalCount })}
    </p>
  )}
```

Add the `home.showing_x_of_y` key (e.g. `"Showing {{shown}} of {{total}}"`) to `apps/ui/src/i18n/locales/en.json` (and the other locale files with the English string as a placeholder if the repo requires all locales present — check how existing keys are handled; match that convention).

> **Partial-not-complete (spec §6):** `meta.partial`/`unavailable_instances` propagation is P5; in P3 the indicator reflects `meta.total` only. Do not present a capped/partial set as "all" — the "X of Y" wording inherently communicates truncation. Add a code comment noting the federation-degradation banner lands in P5.

- [ ] **Step 2: Verify + commit**

Run: `pnpm typecheck` → PASS. Run: `pnpm --filter ui test` → PASS.

```bash
git add apps/ui/src/pages/home-page.tsx apps/ui/src/i18n/locales/*.json
git commit -m "feat(ui): show truncation 'X of Y' on the browse list (#203 §6)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:** §4.1 → Task 1 (distance ORDER BY + integration ordering test). §4.2 → Task 2 (relaxed refinement + unit tests). §5.1 → Tasks 3 (lat/lng plumbing + page size), 4 (paged hook), 5 (list migration: single-domain trusts server order + drops client sort; "All" tab retains client merge-sort; bottom sentinel; page size 50). §6 → Task 6 (X-of-Y indicator; partial-banner deferred to P5 with a note). §4.0 already done.

**Scope Check (writing-plans):** server (§4.1/§4.2) and UI (§5.1/§6) are somewhat independent subsystems. They are kept in one plan because §5.1 depends on §4.1/§4.2 landing first (ordering + relaxed schema) and the whole is one reviewable P3 unit. **Task 5 is the large/risky one** — if review finds it too big, it can be split into single-domain (Steps 1–3) and "All"-tab (Step 4) as two tasks.

**Placeholder scan:** server tasks carry complete code. Task 5 intentionally references existing home-page logic to reuse (enum filter predicate, `sortItemsByNearest`, card rendering) rather than duplicating it — the implementer must extract/reuse, not rewrite; each such reference names the current code region. No `TBD`/`add error handling`-style gaps.

**Type consistency:** `useInfiniteBrowseItems` returns `{ items, total, hasNextPage, isLoading, isFetchingNextPage, fetchNextPage }`, consumed as such in Task 5/6. `FetchNetworkItemsQuery` gains `item_latitude/item_longitude/radius_meters` (Task 3) used by the hook (Task 4). `queryKeys.browseItems(network, domain, filters)` filters now include `{ limit, lat, lng }` — stable content, location change resets paging.

**Interim-state honesty:** in P3 the map + enum-filter + `fullItem` lookups keep reading `useBrowseItems`/`domainItems` (full fetch) while the list pages independently — a deliberate transient duplication resolved in P4 (map → markers endpoint, `domainItems` removed). Nothing ships until the PR merges after P4/P5, so the interim double-fetch is acceptable and is called out here and in the P4 plan notes.

## Notes for P4 / P5
- **P4** removes `useBrowseItems`/`domainItems` from the map path (§5.2 markers endpoint `GET /network/item/markers` + viewport→radius fetch); the list keeps `useInfiniteBrowseItems`. Add the markers schema to the §4.2 refinement then.
- **P5** adds cross-instance scatter-gather ordering (§4.4 — makes distance ordering correct across >1 active instance; P3's ordering is single-instance-correct and degenerates today), `meta.partial`/`unavailable_instances` propagation + the federation-degradation banner (§6), anon count-first (§7), and full cache-key/instance-URL correctness (§8).
