# Finish Caching — home-page migration + invalidate-on-write + tourist + docs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the caching half of the #203 umbrella (caching-spec #196) end-to-end, so only the data-fetching-at-scale work (#203 §4–§9) remains: migrate `home-page.tsx`'s three raw-fetch groups to React Query, close the invalidate-on-write asymmetry (§C5), pass `cache_ttl_seconds` (§C6), align the tourist app to the key factory, and document the caching rule (§5).

**Architecture:** Reuse the hooks built in Phase 2b-iii (`useNetworkConfigs`, `useResolvedNetwork`, `useMyItems`) and add two more (`useProfileConsentStatus`, `useBrowseItems`). Convert `home-page.tsx` so its fetching state (`allNetworks`, `resolvedNetwork`, `myItems`, `consentedProfileIds`, `domainItems`, `loading`, `profilesResolved`, `consentLoaded`) becomes derived query state, keeping the profile-consent gate timing and `activeProfileId` restoration exactly as they are. Browse results are cached raw per domain; the page filters out the user's own items in a derived memo (a view concern, not a cache concern). Writes (`performAction(s)`, profile create/edit, consent-accept) invalidate the relevant queries.

**Tech Stack:** React 19 + Vite, TypeScript (ESM, strict), `@tanstack/react-query` v5 (`useQuery`, `useQueries`, `useQueryClient`), Vitest + `@testing-library/react`.

**Epic context:** Finishes caching-spec (`docs/superpowers/specs/2026-07-10-ui-caching-strategy-design.md`) Part C (§C4 home-page migration, §C5 invalidate-on-write, §C6 `cache_ttl_seconds`), Part C3 tourist key alignment, and §5 the caching-rule documentation. Phases 1, 2a, 2b-i, 2b-ii, 2b-iii are done/reviewed on branch `feat/ui-caching-strategy`. **§8 instance-URL cache-busting (was "2b-v") is documented-and-deferred here (Task 8):** there is no instance/API switcher wired in the UI today (`apiConfig.setSelectedKey` has zero callers), so building clear-on-switch wiring now would be dead code; the `resolvedNetwork(networkId, apiBaseUrl)` key already carries the axis, and the deferral is recorded so it becomes a one-hook add when a switcher lands. **After this plan, the caching half is complete; only #203 §4–§9 (paged/ordered/viewport fetch + relevance) remains.**

## Global Constraints

- **Branch:** all work lands on `feat/ui-caching-strategy`. Do NOT commit to `feature`/`develop` without explicit confirmation.
- **ESM only, strict TS, no `any`.** UI filenames kebab-case. No `// TODO` (open an issue). No new `console.log` (existing `console.error` may stay/move).
- **staleTime tiers (spec §C2), set inside the hooks — never in the page:** Config-like (network config/list, resolved network, profile-consent status) → **`5 * 60 * 1000`** (5 min). Browse feed (others' items) → **`90 * 1000`** (~90 s, the 1–2 min band). The user's own data (my items) → **`60 * 1000`** (60 s). Actions → unchanged (60 s poll).
- **`cache_ttl_seconds` (§C6):** the browse-feed query passes `cache_ttl_seconds: 90` to `/network/item/fetch` (the server enforces its own per-network floor, ≥300 s, so this aligns intent without lowering the server TTL).
- **Query keys come only from `lib/query-keys.ts`** (plus the disabled-sentinel arrays that mirror the existing `useNetworkConfig` style). Invalidation may use a documented network-level **prefix** of a factory key (React Query matches prefixes) — call it out in a comment.
- **queryFn purity:** query functions fetch and return data only — no `setState`/`navigate`/`toast`. Side effects (activeProfileId restoration, the consent gate, toasts/redirects) live in effects reacting to query state, or in mutation success handlers.
- **Forward React Query's queryFn `signal`** into `fetchItems`/`fetchNetworkItems` to preserve abort-on-unmount.
- **Preserve behavior EXACTLY.** Same screens, same loading/empty/error states, same consent-gate timing (no gate flash, no premature browser-geo prompt), same `activeProfileId` restore-once-per-network semantics, same nav/toasts. This is a refactor.
- **Browse caching is raw-then-filter:** the browse queries cache the server response unfiltered; removing the user's own items happens in a derived memo keyed off `myItems` + `currentDomain`, NOT in the queryFn (so a profile edit doesn't force a browse refetch, and the cache stays correct across domain-tab switches).

## File Structure

- `apps/ui/src/lib/query-keys.ts` — **modify**: add `profileConsent(networkId)`.
- `apps/ui/src/lib/query-keys.test.ts` — **modify**: assert the new key.
- `apps/ui/src/hooks/use-profile-consent-status.ts` — **create**: `useProfileConsentStatus(network)`.
- `apps/ui/src/hooks/use-profile-consent-status.test.tsx` — **create**.
- `apps/ui/src/hooks/use-browse-items.ts` — **create**: `useBrowseItems(network, domains)` (per-domain `useQueries`).
- `apps/ui/src/hooks/use-browse-items.test.tsx` — **create**.
- `apps/ui/src/hooks/use-my-items.ts` — **modify**: additively expose `isFetched` (Task 4 needs it for `profilesResolved`).
- `apps/ui/src/hooks/use-my-items.test.tsx` — **modify**: assert `isFetched`.
- `apps/ui/src/pages/home-page.tsx` — **modify** (Tasks 3, 4, 5, 6): the three fetch groups + action/consent invalidation.
- `apps/ui/src/pages/profile-form-page.tsx` — **modify** (Task 6): invalidate `myItems`/`browseItems` on create/update.
- `apps/ui/src/tourist/tourist-app.tsx` — **modify** (Task 7): factory keys + tiers + `cache_ttl_seconds`.
- `apps/ui/src/lib/query-client.ts` + repo `AGENTS.md` + `CLAUDE.md` — **modify** (Task 8): the §5 caching rule + §8 deferral note.

---

### Task 1: `useProfileConsentStatus` hook + `profileConsent` key

**Files:**
- Modify: `apps/ui/src/lib/query-keys.ts`, `apps/ui/src/lib/query-keys.test.ts`
- Create: `apps/ui/src/hooks/use-profile-consent-status.ts`, `apps/ui/src/hooks/use-profile-consent-status.test.tsx`

**Interfaces:**
- Produces: `queryKeys.profileConsent(networkId: string): readonly ['profile-consent', string]`.
- Produces: `useProfileConsentStatus(network: DotNetworkSchema | null)` → the raw `useQuery` result whose `data` is a `Set<string>` of consented item ids (config tier, 5 min). Disabled when `network` is null or the user is unauthenticated. Fail-open: on error, the consumer treats the set as empty.

- [ ] **Step 1: Add the key + its test**

In `apps/ui/src/lib/query-keys.ts`, add after `consentConfig`:

```ts
  // The user's profile-creation-consent status for a network (set of consented
  // item ids). Config-ish; invalidated on consent-accept.
  profileConsent: (networkId: string) => ['profile-consent', networkId] as const,
```

In `apps/ui/src/lib/query-keys.test.ts`, add inside the `describe`:

```ts
  it('defines the profile-consent key', () => {
    expect(queryKeys.profileConsent('blue_dot')).toEqual(['profile-consent', 'blue_dot']);
  });
```

- [ ] **Step 2: Write the failing hook test**

Create `apps/ui/src/hooks/use-profile-consent-status.test.tsx`:

```tsx
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema } from '@/engine/types';
import { useProfileConsentStatus } from './use-profile-consent-status';

vi.mock('@/lib/consent-api', () => ({ getProfileConsentStatus: vi.fn() }));
vi.mock('@/contexts/auth-context', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
import { getProfileConsentStatus } from '@/lib/consent-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const network = { id: 'blue_dot', domains: [] } as unknown as DotNetworkSchema;

describe('useProfileConsentStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns a Set of consented item ids', async () => {
    vi.mocked(getProfileConsentStatus).mockResolvedValue({ consented_item_ids: ['a', 'b'] });
    const { result } = renderHook(() => useProfileConsentStatus(network), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data instanceof Set).toBe(true);
    expect([...(result.current.data ?? [])].sort()).toEqual(['a', 'b']);
  });

  it('is disabled (no fetch) when network is null', () => {
    renderHook(() => useProfileConsentStatus(null), { wrapper });
    expect(getProfileConsentStatus).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter ui exec vitest run src/hooks/use-profile-consent-status.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the hook**

Create `apps/ui/src/hooks/use-profile-consent-status.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { getProfileConsentStatus } from '@/lib/consent-api';
import { useAuth } from '@/contexts/auth-context';
import type { DotNetworkSchema } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

/**
 * The current user's profile-creation-consent status for a network, as a
 * `Set<string>` of consented item ids. Config tier (5 min); the consent-accept
 * mutation invalidates/updates this query. Disabled when there is no network or
 * no authenticated user. Fail-open: on error `data` is undefined and the
 * consumer treats it as an empty set (so the gate still prompts).
 */
export function useProfileConsentStatus(network: DotNetworkSchema | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: network ? queryKeys.profileConsent(network.id) : ['profile-consent', null],
    queryFn: async (): Promise<Set<string>> => {
      if (!network) return new Set<string>();
      const res = await getProfileConsentStatus(network.id);
      return new Set(res.consented_item_ids);
    },
    enabled: !!network && !!user,
    staleTime: 5 * 60 * 1000,
  });
}
```

Run: `pnpm --filter ui exec vitest run src/hooks/use-profile-consent-status.test.tsx`
Expected: PASS.

- [ ] **Step 4: Verify + commit**

Run: `pnpm --filter ui exec vitest run src/lib/query-keys.test.ts` → PASS.
Run: `pnpm typecheck` → PASS.

```bash
git add apps/ui/src/lib/query-keys.ts apps/ui/src/lib/query-keys.test.ts apps/ui/src/hooks/use-profile-consent-status.ts apps/ui/src/hooks/use-profile-consent-status.test.tsx
git commit -m "feat(ui): add useProfileConsentStatus hook + profileConsent query key

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `useBrowseItems` hook

**Files:**
- Create: `apps/ui/src/hooks/use-browse-items.ts`, `apps/ui/src/hooks/use-browse-items.test.tsx`

**Interfaces:**
- Consumes: `queryKeys.browseItems` (existing); `fetchNetworkItems`, `PROFILE_FETCH_LIMIT` from `@/lib/network-api`; `Item` from `@/lib/item-api`; `DotNetworkSchema`, `DotNetworkDomain` from `@/engine/types`.
- Produces: `useBrowseItems(network: DotNetworkSchema | null, domains: DotNetworkDomain[]): { data: Record<string, Item[]>; isLoading: boolean }` — runs one query per domain (`useQueries`), keyed `browseItems(networkId, domainId, { limit })`, browse tier (90 s), passing `cache_ttl_seconds: 90`. Returns a map of domainId → **raw** items (own-item filtering is the caller's concern). `isLoading` is true while any domain query is loading.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/hooks/use-browse-items.test.tsx`:

```tsx
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { useBrowseItems } from './use-browse-items';

vi.mock('@/lib/network-api', () => ({
  fetchNetworkItems: vi.fn(),
  PROFILE_FETCH_LIMIT: 1000,
}));
import { fetchNetworkItems } from '@/lib/network-api';

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const item = (id: string): Item => ({ item_id: id } as unknown as Item);
const network = { id: 'blue_dot', domains: [] } as unknown as DotNetworkSchema;
const domains = [
  { id: 'student', item_schemas: { 'profile_1.0': {} } },
  { id: 'mentor', item_schemas: { 'profile_1.0': {} } },
] as unknown as DotNetworkDomain[];

describe('useBrowseItems', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns raw items keyed by domain and passes cache_ttl_seconds', async () => {
    vi.mocked(fetchNetworkItems).mockImplementation(async (q) => ({
      meta: { total: 0, limit: 1000, offset: 0 },
      items: q.item_domain === 'student' ? [item('a')] : [item('b')],
    }));
    const { result } = renderHook(() => useBrowseItems(network, domains), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data.student.map((i) => i.item_id)).toEqual(['a']);
    expect(result.current.data.mentor.map((i) => i.item_id)).toEqual(['b']);
    expect(fetchNetworkItems).toHaveBeenCalledWith(
      expect.objectContaining({ cache_ttl_seconds: 90, item_domain: 'student' }),
      expect.anything(),
    );
  });

  it('runs no queries when network is null', () => {
    renderHook(() => useBrowseItems(null, domains), { wrapper });
    expect(fetchNetworkItems).not.toHaveBeenCalled();
  });
});
```

Run: `pnpm --filter ui exec vitest run src/hooks/use-browse-items.test.tsx`
Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement the hook**

Create `apps/ui/src/hooks/use-browse-items.ts`:

```ts
import { useQueries } from '@tanstack/react-query';
import { fetchNetworkItems, PROFILE_FETCH_LIMIT } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import type { DotNetworkSchema, DotNetworkDomain } from '@/engine/types';
import { queryKeys } from '@/lib/query-keys';

// Browse tier (spec §C2): others' items are cached ~90s client-side; the server
// cache (per-network floor ≥300s) absorbs the rest. `cache_ttl_seconds` is sent
// so the client's intent is aligned with the server knob (§C6); the server
// still enforces its own floor.
const BROWSE_STALE_TIME_MS = 90 * 1000;
const BROWSE_CACHE_TTL_SECONDS = 90;

interface UseBrowseItemsResult {
  data: Record<string, Item[]>;
  isLoading: boolean;
}

/**
 * Fetch browse items (others' profiles/postings via `/network/item/fetch`) for
 * a set of domains, one cached query per domain, and return them as a
 * domainId → items map. Items are RAW (unfiltered): the caller removes its own
 * items in a derived memo so the cache holds the true server response and a
 * profile edit doesn't force a browse refetch. Own-item filtering must NOT move
 * into this hook.
 */
export function useBrowseItems(
  network: DotNetworkSchema | null,
  domains: DotNetworkDomain[],
): UseBrowseItemsResult {
  const active = network ? domains : [];

  const results = useQueries({
    queries: active.map((domain) => {
      const itemTypeKeys = domain.item_schemas ? Object.keys(domain.item_schemas) : [];
      const itemType = itemTypeKeys.length > 0 ? itemTypeKeys[0] : 'profile';
      return {
        queryKey: queryKeys.browseItems(network!.id, domain.id, { limit: PROFILE_FETCH_LIMIT }),
        queryFn: async ({ signal }: { signal: AbortSignal }): Promise<Item[]> => {
          const res = await fetchNetworkItems(
            {
              item_network: network!.id,
              item_domain: domain.id,
              item_type: itemType,
              limit: PROFILE_FETCH_LIMIT,
              cache_ttl_seconds: BROWSE_CACHE_TTL_SECONDS,
            },
            signal,
          );
          return res.items;
        },
        staleTime: BROWSE_STALE_TIME_MS,
      };
    }),
  });

  const data: Record<string, Item[]> = {};
  active.forEach((domain, i) => {
    data[domain.id] = results[i]?.data ?? [];
  });

  return { data, isLoading: results.some((r) => r.isLoading) };
}
```

Run: `pnpm --filter ui exec vitest run src/hooks/use-browse-items.test.tsx`
Expected: PASS.

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck` → PASS.

```bash
git add apps/ui/src/hooks/use-browse-items.ts apps/ui/src/hooks/use-browse-items.test.tsx
git commit -m "feat(ui): add useBrowseItems hook (per-domain cached browse feed)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: home-page migration 1/3 — networks list + resolved network

Replace the two network fetch effects (`fetchNetworkConfigs` at ~250–274; `fetchNetworkConfig` + `resolveNetworkRefs` at ~277–302) with `useNetworkConfigs` + `useResolvedNetwork`. The page must typecheck and the full UI suite must stay green (the other two fetch groups still use raw fetches after this task — that is fine; they read `network`, which now comes from the hook).

**Files:** Modify `apps/ui/src/pages/home-page.tsx`.

**Interfaces:** Consumes `useNetworkConfigs`, `useResolvedNetwork` from `@/hooks/use-network-config`.

- [ ] **Step 1: Add imports**

Add near the other `@/hooks` imports:

```ts
import { useNetworkConfigs, useResolvedNetwork } from '@/hooks/use-network-config';
```

- [ ] **Step 2: Replace `allNetworks`/`resolvedNetwork` state + the two fetch effects**

Delete the state declarations `const [resolvedNetwork, setResolvedNetwork] = React.useState<DotNetworkSchema | null>(null);` (~205) and `const [allNetworks, setAllNetworks] = React.useState<DotNetworkSchema[]>([]);` (~206).

Delete the two effects: the mount networks fetch (`fetchNetworkConfigs().then(...)`, ~250–274) and the resolve-selected-network effect (`fetchNetworkConfig(selectedNetworkId)...`, ~277–302). Also delete the `const network = resolvedNetwork;` line (~304) — it is re-declared below.

Insert, right after the `const [selectedNetworkId, setSelectedNetworkId] = ...` declaration and the other `useState`s (before the `activeProfileId` storage effect ~241):

```ts
  // Networks list + resolved selected network (config tier). Replaces the raw
  // mount-fetch + resolve effects; `allNetworks`/`network` are now query-derived.
  const { data: networksData } = useNetworkConfigs();
  const allNetworks = React.useMemo<DotNetworkSchema[]>(() => {
    if (!networksData) return [];
    return configuredNetworkIds.length > 0
      ? networksData.filter((n) => configuredNetworkIds.includes(n.id))
      : networksData;
  }, [networksData, configuredNetworkIds]);

  const { data: resolvedNetwork } = useResolvedNetwork(selectedNetworkId);
  const network = resolvedNetwork;
```

> `configuredNetworkIds` is already computed in the component (used by `initialNetworkId`). If it is declared *below* this insertion point, move this block to just after `configuredNetworkIds` so the reference resolves. Keep `selectedNetworkId`'s `useState` where it is.

- [ ] **Step 3: Restore the default-network auto-selection (previously done inside the networks fetch)**

The old mount fetch set `selectedNetworkId` to the first available network when none was selected. Reproduce that as an effect (place it just after the `allNetworks` memo):

```ts
  // Default the selected network to the first available once the list loads
  // (only when nothing is selected yet) — previously done in the mount fetch.
  React.useEffect(() => {
    if (selectedNetworkId) return;
    const first = allNetworks[0]?.id;
    if (first) setSelectedNetworkId(first);
  }, [allNetworks, selectedNetworkId]);
```

- [ ] **Step 4: Typecheck and fix fallout**

Run: `pnpm typecheck`
Expected: PASS. If `resolveNetworkRefs` / `apiConfig` / `fetchNetworkConfigs` / `fetchNetworkConfig` are now unused, remove them from the imports — **but** verify each first: `apiConfig` is still used elsewhere in this file (`apiConfig.getUrl()` ~1157), so keep it; `resolveNetworkRefs` and the two `fetchNetworkConfig*` are likely now unused (remove). If typecheck says a symbol is still used, keep it. Re-run until clean.

- [ ] **Step 5: Full suite + commit**

Run: `pnpm --filter ui test` → full UI suite green.

```bash
git add apps/ui/src/pages/home-page.tsx
git commit -m "feat(ui): migrate home-page networks list + resolved config to React Query

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: home-page migration 2/3 — my-profiles + consent + gate

Replace the coordinated my-profiles+consent effect (~321–385) with `useMyItems` + `useProfileConsentStatus`, deriving `myItems`/`consentedProfileIds`/`profilesResolved`/`consentLoaded` from query state and moving `activeProfileId` restoration into a guarded effect. The consent-gate timing and restore-once-per-network semantics must be preserved exactly.

**Files:**
- Modify: `apps/ui/src/hooks/use-my-items.ts`, `apps/ui/src/hooks/use-my-items.test.tsx` (Step 1)
- Modify: `apps/ui/src/pages/home-page.tsx` (Steps 2–5)

**Interfaces:**
- `useMyItems` return becomes `{ data: Item[]; isLoading: boolean; isFetched: boolean }` (additive).
- Consumes `useMyItems` (`@/hooks/use-my-items`) and `useProfileConsentStatus` (`@/hooks/use-profile-consent-status`).

- [ ] **Step 1: Additively expose `isFetched` from `useMyItems` (TDD)**

In `apps/ui/src/hooks/use-my-items.test.tsx`, add to the "flattens" test after the existing assertions:

```ts
    expect(result.current.isFetched).toBe(true);
```

Run: `pnpm --filter ui exec vitest run src/hooks/use-my-items.test.tsx`
Expected: FAIL — `isFetched` is `undefined`.

In `apps/ui/src/hooks/use-my-items.ts`, change the destructure and return:

```ts
  const { data, isLoading, isFetched } = useQuery({
    // ...unchanged query config...
  });

  return { data: data ?? [], isLoading, isFetched };
```

Update the `UseMyItemsResult` interface to add `isFetched: boolean`.

Run the test again → PASS. (The profile-form-page consumer destructures only `data`, so the additive field is safe.)

- [ ] **Step 2: Add imports + hook calls in home-page**

Add imports:

```ts
import { useMyItems } from '@/hooks/use-my-items';
import { useProfileConsentStatus } from '@/hooks/use-profile-consent-status';
```

Add the hook calls right after the `network` declaration from Task 3:

```ts
  // My profiles across domains (own-data tier) + profile-consent status
  // (config tier). Replace the coordinated raw fetch; the gate reads both.
  const { data: myItems, isFetched: myItemsFetched } = useMyItems(network);
  const consentQuery = useProfileConsentStatus(network);
  const consentedProfileIds = consentQuery.data ?? new Set<string>();
  // Settled = query resolved either way (fail-open: an error yields an empty set
  // and still marks loaded, so the gate can prompt). Signed-out users have no
  // profiles/consent to wait for — resolved immediately.
  const profilesResolved = !user || myItemsFetched;
  const consentLoaded = !user || consentQuery.isSuccess || consentQuery.isError;
```

- [ ] **Step 3: Remove the replaced state + effect**

Delete these `useState` declarations: `const [myItems, setMyItems] = ...` (~227), `const [consentedProfileIds, setConsentedProfileIds] = ...` (~233), `const [consentLoaded, setConsentLoaded] = ...` (~234), `const [profilesResolved, setProfilesResolved] = ...` (~232).

Delete the entire coordinated fetch effect (`React.useEffect(() => { if (!network) return; ... }, [network, user]);`, ~321–385).

- [ ] **Step 4: Re-add `activeProfileId` restoration as a guarded effect (restore-once-per-network)**

The old effect restored/selected `activeProfileId` once when profiles loaded for a network. Add a ref + effect (place where the deleted effect was):

```ts
  // Restore or auto-select the active profile once per network, when my-profiles
  // have settled. A ref guards against re-running on a background refetch
  // (which must not reset the user's manual selection).
  const restoredForNetwork = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!user) {
      // Signed out: clear selection and allow restoration to re-run on next sign-in.
      setActiveProfileId(null);
      restoredForNetwork.current = null;
      return;
    }
    if (!network || !myItemsFetched) return;
    if (restoredForNetwork.current === network.id) return;
    restoredForNetwork.current = network.id;

    const storedId = getStoredActiveProfileId(network.id);
    if (storedId && myItems.some((p) => p.item_id === storedId)) {
      setActiveProfileId(storedId);
    } else if (myItems.length > 0) {
      setActiveProfileId(myItems[0].item_id);
      setStoredActiveProfileId(network.id, myItems[0].item_id);
    } else {
      setActiveProfileId(null);
      clearStoredActiveProfileId(network.id);
    }
  }, [user, network, myItemsFetched, myItems]);
```

> Keep the existing `activeProfileId`-from-storage effect on `selectedNetworkId` (~241–247) — it seeds the stored id synchronously on network switch; this new effect then re-validates it once profiles load, matching the old two-step behavior.

- [ ] **Step 5: Typecheck, full suite, commit**

Run: `pnpm typecheck` → PASS (remove `getProfileConsentStatus`, `fetchItems`, `getItemTypeForDomain` from imports/file **only if** now unused — verify; `getItemTypeForDomain` may still be used by Task 5's not-yet-migrated browse effect, so it likely stays until Task 5).
Run: `pnpm --filter ui test` → full UI suite green.

```bash
git add apps/ui/src/pages/home-page.tsx apps/ui/src/hooks/use-my-items.ts apps/ui/src/hooks/use-my-items.test.tsx
git commit -m "feat(ui): migrate home-page my-profiles + consent status to React Query

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: home-page migration 3/3 — browse feed

Replace the browse-items effect (~556–594) with `useBrowseItems`, deriving the filtered `domainItems` map and `loading` from the hook.

**Files:** Modify `apps/ui/src/pages/home-page.tsx`.

**Interfaces:** Consumes `useBrowseItems` (`@/hooks/use-browse-items`).

- [ ] **Step 1: Add import**

```ts
import { useBrowseItems } from '@/hooks/use-browse-items';
```

- [ ] **Step 2: Replace the browse effect + `domainItems`/`loading` state**

Delete the `const [domainItems, setDomainItems] = React.useState<Record<string, Item[]>>({});` (~226) and `const [loading, setLoading] = React.useState(false);` (~236) declarations.

Delete the entire browse `React.useEffect(() => { if (!network || visibleDomains.length === 0) ... }, [selectedDomain, visibleDomains, network, localProfileItemIds]);` (~556–594).

Insert (place after `localProfileItemIds` ~550–553 so both are in scope):

```ts
  // Which domains to fetch: All-tab (null) = every visible domain; else the one.
  const domainsToFetch = React.useMemo(
    () =>
      selectedDomain === null
        ? visibleDomains
        : visibleDomains.filter((d) => d.id === selectedDomain),
    [selectedDomain, visibleDomains],
  );

  // Browse feed (cached per domain, ~90s). Raw items come back; filter out the
  // user's own items here (a view concern) so the cache holds the true server
  // response and survives domain-tab switches without refetching.
  const { data: browseData, isLoading: loading } = useBrowseItems(network, domainsToFetch);

  const domainItems = React.useMemo<Record<string, Item[]>>(() => {
    const filtered: Record<string, Item[]> = {};
    for (const [domainId, items] of Object.entries(browseData)) {
      filtered[domainId] = items.filter((it) => !localProfileItemIds.has(it.item_id));
    }
    return filtered;
  }, [browseData, localProfileItemIds]);
```

- [ ] **Step 3: Typecheck, full suite, commit**

Run: `pnpm typecheck` → PASS. Remove now-unused imports (`fetchNetworkItems`, `PROFILE_FETCH_LIMIT`, `getItemTypeForDomain` if no longer referenced, `fetchItems`) — verify each with typecheck; keep anything still used (e.g. `getItemTypeForDomain` may be used by `getActionsForDomain` or other code — only remove if typecheck confirms unused).
Run: `pnpm --filter ui test` → full UI suite green.

```bash
git add apps/ui/src/pages/home-page.tsx
git commit -m "feat(ui): migrate home-page browse feed to React Query (cached per domain)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Invalidate-on-write (§C5)

Close the invalidation asymmetry across the pages that write.

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx` (actions + consent-accept)
- Modify: `apps/ui/src/pages/profile-form-page.tsx` (create/update)

**Interfaces:** Consumes `useQueryClient` from `@tanstack/react-query`; `queryKeys` from `@/lib/query-keys`.

- [ ] **Step 1: home-page — invalidate actions on action creation**

Add imports (if not present):

```ts
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
```

Add near the top of the component body:

```ts
  const queryClient = useQueryClient();
```

After a successful `performActionsBulk(...)` (~713, the `env` result before the toasts) add:

```ts
        // New actions must surface without waiting for the 60s poll (§C5).
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
```

After the successful single `performAction(...)` call (~1160) add the same line:

```ts
        queryClient.invalidateQueries({ queryKey: queryKeys.actions.all });
```

> Place each invalidation on the success path only (after the `await` resolves, before/after the success toast — not in a catch).

- [ ] **Step 2: home-page — consent-accept updates the consent query**

In the `ProfileConsentModal` `onAccept` handler (~922–947), replace the local set mutation `setConsentedProfileIds((prev) => new Set([...prev, pending]));` with an optimistic cache update + invalidation (preserves the no-flash gate close):

```ts
          // Optimistically mark consented so the gate closes immediately, then
          // invalidate to reconcile with the server (§C5).
          queryClient.setQueryData<Set<string>>(
            queryKeys.profileConsent(network.id),
            (prev) => new Set([...(prev ?? []), pending]),
          );
          queryClient.invalidateQueries({ queryKey: queryKeys.profileConsent(network.id) });
```

Keep the surrounding `setActiveProfileId(pending)` / `setStoredActiveProfileId(...)` / `setPendingConsentProfileId(null)` lines unchanged.

- [ ] **Step 3: profile-form-page — invalidate my-items + browse on create/update**

In `apps/ui/src/pages/profile-form-page.tsx`, add:

```ts
import { useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query-keys';
```

Add `const queryClient = useQueryClient();` in the component body (near the other hooks).

In `handleSubmit`, after a successful `updateItem(...)` and after a successful `createItem(...)` (both inside the `try`, right after the `await` and before the success toast), invalidate the network's own-items and browse caches so the change is visible immediately (§C5):

```ts
        // Reflect the write immediately in cached lists (§C5).
        queryClient.invalidateQueries({ queryKey: queryKeys.myItems(network.id) });
        // Network-level prefix of the browse-items key (React Query matches
        // prefixes) — invalidates every domain's browse cache for this network.
        queryClient.invalidateQueries({ queryKey: ['browse-items', network.id] });
```

> `network` is in scope in `handleSubmit` (the guard `if (!selectedDomain || !network) return;` runs first). Add the two lines in both the update and the create branches.

- [ ] **Step 4: Typecheck, full suite, commit**

Run: `pnpm typecheck` → PASS.
Run: `pnpm --filter ui test` → full UI suite green.

```bash
git add apps/ui/src/pages/home-page.tsx apps/ui/src/pages/profile-form-page.tsx
git commit -m "feat(ui): invalidate-on-write for actions, profile-consent, and my/browse items

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Align the tourist app to the key factory + `cache_ttl_seconds`

**Files:** Modify `apps/ui/src/tourist/tourist-app.tsx`.

**Interfaces:** Consumes `queryKeys` from `@/lib/query-keys`. Keeps the inline `useQuery` calls (so `configQuery.refetch()` / `itemsQuery.isError` in the retry UI still work) — only the keys, tiers, and the browse `cache_ttl_seconds` change.

- [ ] **Step 1: Import the factory**

```ts
import { queryKeys } from '@/lib/query-keys';
```

- [ ] **Step 2: Config query → factory key + config tier**

Replace the `configQuery` definition (~49–52):

```ts
  const configQuery = useQuery({
    queryKey: queryKeys.networkConfig(ORANGE_NETWORK_ID),
    queryFn: () => fetchNetworkConfig(ORANGE_NETWORK_ID),
    staleTime: 5 * 60 * 1000,
  });
```

- [ ] **Step 3: Items query → factory browse key + browse tier + `cache_ttl_seconds`**

Replace the `itemsQuery` definition (~60–68):

```ts
  const itemsQuery = useQuery({
    enabled: !!network,
    queryKey: queryKeys.browseItems(ORANGE_NETWORK_ID, ORANGE_DOMAIN_ID, {
      limit: PROFILE_FETCH_LIMIT,
    }),
    queryFn: ({ signal }) =>
      fetchNetworkItems(
        {
          item_network: ORANGE_NETWORK_ID,
          item_domain: ORANGE_DOMAIN_ID,
          item_type: itemType,
          limit: PROFILE_FETCH_LIMIT,
          cache_ttl_seconds: 90,
        },
        signal,
      ),
    staleTime: 90 * 1000,
  });
```

> The tourist entry point has its own QueryClient, so sharing the `networkConfig`/`browseItems` key names with the main app cannot cross-contaminate; the data shapes are identical anyway. `itemType` is derived above the query (unchanged) and is stable for the orange domain.

- [ ] **Step 4: Verify + commit**

Run: `pnpm typecheck` → PASS.
Run: `pnpm --filter ui test` → full UI suite green.

```bash
git add apps/ui/src/tourist/tourist-app.tsx
git commit -m "feat(ui): align tourist app to query-key factory + cache_ttl_seconds

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Document the caching rule (§5) + the §8 deferral

**Files:**
- Modify: `apps/ui/src/lib/query-client.ts` (rule comment)
- Modify: repo `AGENTS.md` and `CLAUDE.md` (rule + §8 deferral note)

**Interfaces:** none (documentation only).

- [ ] **Step 1: Add the caching-rule comment to `createQueryClient`**

In `apps/ui/src/lib/query-client.ts`, extend the doc comment on `createQueryClient` with the tier rule (spec §5):

```ts
/**
 * ...existing text...
 *
 * Caching rule (spec §5) — pick the tier when adding a query:
 *  - Config-like, rarely-changing (network config/list, consent config,
 *    profile-consent status, resolved schemas): staleTime 5 min; invalidate on
 *    the event that changes it.
 *  - Feeds of others' data (browse `/network/item/fetch`): staleTime ~90s; the
 *    server cache (~5 min) absorbs the rest; pass `cache_ttl_seconds`.
 *  - The user's own data (my items): staleTime 60s + invalidate-on-write.
 *  - Polled / near-real-time (actions): `refetchInterval` + invalidate-on-write.
 *  - Expensive external lookups keyed by immutable input (geocode): dedicated
 *    cache (Redis server-side; in-memory session client-side), not React Query.
 * Never rely on `refetchOnWindowFocus` for freshness. One QueryClient config,
 * one key factory (`lib/query-keys.ts`).
 */
```

- [ ] **Step 2: Add the rule + §8 deferral to `AGENTS.md` and `CLAUDE.md`**

Add a short "UI data caching" subsection to each file (place near other UI/frontend guidance). Content:

```markdown
### UI data caching (React Query)

One QueryClient (`apps/ui/src/lib/query-client.ts`), one key factory
(`apps/ui/src/lib/query-keys.ts`). staleTime tiers: config-like data 5 min
(invalidate on change), browse feeds ~90s (+ `cache_ttl_seconds`), own data 60s
(+ invalidate-on-write), actions via `refetchInterval`. Geocoding uses dedicated
caches (Redis server-side, in-memory session client-side), not React Query.
Never rely on `refetchOnWindowFocus` for freshness.

**Deferred — instance-URL cache-busting (caching-spec §8):** when a
`selectedApiUrl` / instance switcher is added to the UI, switching it must bust
the React Query caches (browse/my-items/markers) and the client schema cache
(`clearSchemaCache`), because `createApiClient` captures `baseURL` at
construction. The `resolvedNetwork(networkId, apiBaseUrl)` key already carries
the API base URL. There is no switcher today, so no busting is wired yet.
```

- [ ] **Step 3: Verify + commit**

Run: `pnpm typecheck` → PASS (comment-only change to TS; docs are markdown).

```bash
git add apps/ui/src/lib/query-client.ts AGENTS.md CLAUDE.md
git commit -m "docs(ui): document the React Query caching tier rule + §8 deferral

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- §C4 migrate raw-fetch pages (home-page: config `:250/:287`, my-profiles `:321`, browse `:556`) → Tasks 3, 4, 5. Reuse `useNetworkConfig`/`useConsentConfig` → `useResolvedNetwork` composes `useNetworkConfig`; `useConsentConfig` already in use; profile-consent status now a query.
- §C5 invalidate-on-write (create/edit → my/browse; action creation → actions; consent-accept → invalidate not local Set) → Task 6.
- §C6 pass `cache_ttl_seconds` → Task 2 (browse hook) + Task 7 (tourist).
- §C3 tourist reuses the factory keys → Task 7.
- §C2 tiers → enforced inside every hook (config 5 min, browse 90s, own 60s), never in the page.
- §5 caching-rule documentation → Task 8.
- §8 instance-URL busting → documented-and-deferred (Task 8), with rationale (no switcher exists; key axis already present).

**Placeholder scan:** none — full code for the hooks, precise before/after edits for the page tasks, exact commands with expected output. Conditional import removals (Tasks 3/4/5) are grounded in a concrete `pnpm typecheck` signal, not a guess.

**Type consistency:** `useMyItems` return extended additively to `{ data, isLoading, isFetched }` (profile-form consumer destructures only `data`); `useProfileConsentStatus` returns a `Set<string>` under `data`; `useBrowseItems` returns `Record<string, Item[]>`; `queryKeys.profileConsent` used with matching arity in hook + test; browse invalidation uses the documented `['browse-items', networkId]` prefix.

**Behavior preservation (the risk surface):**
- Consent gate: `profilesResolved`/`consentLoaded` are derived from the two queries; the gate effect already requires both flags, so the no-flash timing holds even though the two queries settle independently. Fail-open preserved (error → empty set → gate still prompts).
- `activeProfileId` restore-once-per-network preserved via the `restoredForNetwork` ref; a background refetch (e.g. after invalidate-on-write) will not reset a manual selection. Sign-out clears selection and resets the guard.
- Browse own-item filtering moved to a derived memo (cache holds raw items); domain-tab switch is served from cache; a profile edit invalidates browse rather than being filtered at fetch time.
- Loading/empty/error screens unchanged (they read `network`, `loading`, `domainItems` — same names, now derived).

**Notes for the executor (verification split):** the two new hooks (Tasks 1–2) and the `useMyItems` change (Task 4 Step 1) are unit-tested (TDD). The page integrations (Tasks 3–7) are verified by `pnpm typecheck` + `pnpm --filter ui test` + the manual browser smoke below — consistent with how 2b-iii verified page wiring. Task 4 (consent gate) is the highest-risk task; give it the closest review and smoke attention.

## Manual smoke (run after Task 6; needs a live browser — controller/human)
Bring the stack up (`/run-signals-dpg`) on the largest available dot, then verify:
1. **Browse cached:** switch domain tabs / navigate away and back → no repeat `/network/item/fetch` for an already-loaded domain (Network tab); results still correct (own items excluded).
2. **My profiles + gate:** logged-in user with a profile → correct active profile selected; an aggregator-created profile lacking consent → the consent gate prompts (no flash, no premature browser-geo prompt); accept → gate closes immediately and stays closed on reload.
3. **Invalidate-on-write:** create/edit a profile → returning to home shows the change without a hard reload; send a connect action → the pending-actions badge updates without waiting ~60s.
4. **Tourist app:** orange-dots UI still loads config + practitioners; retry button still works on a forced error.
5. **Signed-out:** browse works; no stuck spinner; no console errors.
