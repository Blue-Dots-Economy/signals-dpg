# Caching Phase 2a — Client Geocoding Cache + Removals — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a session-scoped client geocoding cache (kills repeated paid Places calls from autocomplete + map marker resolution) and clear two caching-baseline liabilities (a dead consent hook, the global focus-refetch storm).

**Architecture:** A transparent memoizing wrapper behind `getGeoProvider()` caches `suggest`/`geocode` results by normalized query with in-flight dedup and a bounded LRU — every call site benefits without changing. Separately, delete the never-imported `useConsentGate` (+ its sole-consumer `getConsentStatus`) and flip the global React Query `refetchOnWindowFocus` to `false`.

**Tech Stack:** React 19 + Vite, TypeScript (ESM, strict), Vitest, @tanstack/react-query.

**Epic context:** Phase 2a of the #203 umbrella (`docs/superpowers/specs/2026-07-13-ui-data-fetching-at-scale-design.md`). Implements caching-spec (`docs/superpowers/specs/2026-07-10-ui-caching-strategy-design.md`) **Part B** and the two trivial **Part D** removals (§3.2, §3.3). The `schemaCache` replacement (§3.1) and Part C (React Query standardization) are deferred to Plan 2b. Phase 1 (#196, server geocoding cache) is already merged on this branch.

## Global Constraints

- **Branch:** all work lands on `feat/ui-caching-strategy`. Do NOT commit to `feature` or `develop`.
- **ESM only, strict TS, no `any`.** UI filenames are **kebab-case** (`geo-cache.ts`), not snake_case.
- **No `// TODO` comments** — open an issue instead.
- **Client geo cache is SESSION-only** — in-memory, cleared on page reload. No `localStorage`/`IndexedDB` persistence.
- **Do not cache empty/error results.** The providers return `[]` (suggest) / `null` (geocode) on *both* "no match" and transient error, indistinguishably — so only cache a non-empty `suggest` array and a non-null `geocode` result. In-flight dedup still applies to every call.
- **PII-masked queries must short-circuit BEFORE the cache** — a masked value (`looksLikePIIMask`) is never fetched and never cached (preserve the existing guard in `getGeoProvider`).
- **Preserve public signatures:** `GeoProvider.suggest(query, signal?)` / `.geocode(address, signal?)` and `getGeoProvider()` are unchanged. Keep `getConsentStatusByIdentifier` (only `getConsentStatus` is removed).

## File Structure

- `apps/ui/src/lib/geo/geo-cache.ts` — **create**: `normalizeGeoKey`, `memoizeGeoLookup`, `withGeoCache`.
- `apps/ui/src/lib/geo/geo-cache.test.ts` — **create**: unit tests.
- `apps/ui/src/lib/geo/provider.ts` — **modify**: wrap the base provider with `withGeoCache` inside `getGeoProvider()`.
- `apps/ui/src/hooks/use-consent-gate.ts` — **delete** (dead).
- `apps/ui/src/lib/consent-api.ts` — **modify**: remove `getConsentStatus` (keep `getConsentStatusByIdentifier`).
- `apps/ui/src/main.tsx` — **modify**: `refetchOnWindowFocus: false`.

---

### Task 1: Geo memoization core (`normalizeGeoKey` + `memoizeGeoLookup`)

**Files:**
- Create: `apps/ui/src/lib/geo/geo-cache.ts`
- Create: `apps/ui/src/lib/geo/geo-cache.test.ts`

**Interfaces:**
- Produces:
  - `normalizeGeoKey(query: string): string` — trim + lowercase + collapse internal whitespace.
  - `memoizeGeoLookup<T>(fn: (query: string) => Promise<T>, shouldCache: (value: T) => boolean, cap?: number): (query: string, signal?: AbortSignal) => Promise<T>` — LRU-bounded (default cap 500), keyed by `normalizeGeoKey`, with in-flight dedup. Caches a resolved value only when `shouldCache(value)` is true. The `signal` param is accepted for call-site compatibility but intentionally NOT forwarded to the shared underlying call.

- [ ] **Step 1: Write the failing tests**

Create `apps/ui/src/lib/geo/geo-cache.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { normalizeGeoKey, memoizeGeoLookup } from './geo-cache';

describe('normalizeGeoKey', () => {
  it('trims, lowercases, and collapses internal whitespace', () => {
    expect(normalizeGeoKey('  Noida,   Uttar   Pradesh ')).toBe('noida, uttar pradesh');
  });
  it('is stable across case/spacing variants', () => {
    expect(normalizeGeoKey('GHAZIABAD')).toBe(normalizeGeoKey('  ghaziabad '));
  });
});

describe('memoizeGeoLookup', () => {
  it('calls the underlying fn once for repeated (normalized) queries', async () => {
    const fn = vi.fn().mockResolvedValue(['x']);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
    await memo('Delhi');
    await memo('  DELHI ');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not collide distinct queries', async () => {
    const fn = vi.fn(async (q: string) => [q]);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
    await memo('Delhi');
    await memo('Mumbai');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent in-flight identical lookups to one call', async () => {
    let resolve!: (v: string[]) => void;
    const fn = vi.fn(() => new Promise<string[]>((r) => { resolve = r; }));
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
    const a = memo('Delhi');
    const b = memo('Delhi');
    resolve(['x']);
    expect(await a).toEqual(['x']);
    expect(await b).toEqual(['x']);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not cache an un-cacheable (empty) result — retries next time', async () => {
    const fn = vi.fn().mockResolvedValue([] as string[]);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0);
    await memo('Nowhere');
    await memo('Nowhere');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('evicts the oldest entry past the cap (LRU)', async () => {
    const fn = vi.fn(async (q: string) => [q]);
    const memo = memoizeGeoLookup(fn, (v) => v.length > 0, 2);
    await memo('a'); // cached
    await memo('b'); // cached
    await memo('c'); // evicts 'a'
    await memo('a'); // 'a' was evicted → refetch
    expect(fn).toHaveBeenCalledTimes(4);
    fn.mockClear();
    await memo('c'); // still cached
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter ui exec vitest run src/lib/geo/geo-cache.test.ts`
Expected: FAIL — cannot resolve `./geo-cache` / exports undefined.

- [ ] **Step 3: Implement `geo-cache.ts` (core only)**

Create `apps/ui/src/lib/geo/geo-cache.ts`:

```ts
/** Default LRU cap for a memoized geo lookup (entries). */
const DEFAULT_CACHE_CAP = 500;

/**
 * Normalize a place query so case/spacing variants share one cache entry:
 * trim, lowercase, and collapse internal whitespace runs to a single space.
 */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Session-scoped memoizing wrapper for an async geo lookup. Bounded LRU
 * (insertion-order, `cap` entries) keyed by `normalizeGeoKey(query)`, with
 * in-flight dedup so concurrent identical lookups collapse to one call. Only
 * results for which `shouldCache(value)` is true are stored (so a transient
 * empty/error result is not cached). The `signal` is accepted for call-site
 * compatibility but deliberately NOT forwarded to the shared underlying call —
 * one waiter must not abort a promise shared by others; callers still gate on
 * their own signal before using the resolved value.
 */
export function memoizeGeoLookup<T>(
  fn: (query: string) => Promise<T>,
  shouldCache: (value: T) => boolean,
  cap: number = DEFAULT_CACHE_CAP,
): (query: string, signal?: AbortSignal) => Promise<T> {
  const resolved = new Map<string, T>();
  const inFlight = new Map<string, Promise<T>>();

  return (query: string): Promise<T> => {
    const key = normalizeGeoKey(query);

    if (resolved.has(key)) {
      const value = resolved.get(key)!;
      resolved.delete(key); // refresh LRU recency
      resolved.set(key, value);
      return Promise.resolve(value);
    }

    const pending = inFlight.get(key);
    if (pending) return pending;

    const promise = fn(query)
      .then((value) => {
        if (shouldCache(value)) {
          resolved.set(key, value);
          if (resolved.size > cap) {
            const oldest = resolved.keys().next().value as string;
            resolved.delete(oldest);
          }
        }
        return value;
      })
      .finally(() => {
        inFlight.delete(key);
      });

    inFlight.set(key, promise);
    return promise;
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter ui exec vitest run src/lib/geo/geo-cache.test.ts`
Expected: PASS (all 7 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/geo/geo-cache.ts apps/ui/src/lib/geo/geo-cache.test.ts
git commit -m "feat(ui): add session geo lookup memoizer (LRU + in-flight dedup)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `withGeoCache` wrapper + wire into `getGeoProvider`

**Files:**
- Modify: `apps/ui/src/lib/geo/geo-cache.ts`
- Modify: `apps/ui/src/lib/geo/geo-cache.test.ts`
- Modify: `apps/ui/src/lib/geo/provider.ts:16-33` (`getGeoProvider`)

**Interfaces:**
- Consumes: `memoizeGeoLookup` (Task 1); `GeoProvider`, `GeoSuggestion`, `LatLng` from `./types`.
- Produces: `withGeoCache(base: GeoProvider): GeoProvider` — returns a provider whose `suggest`/`geocode` are session-cached (suggest cached when the array is non-empty; geocode cached when non-null).

- [ ] **Step 1: Write the failing tests**

Append to `apps/ui/src/lib/geo/geo-cache.test.ts`:

```ts
import { withGeoCache } from './geo-cache';
import type { GeoProvider } from './types';

describe('withGeoCache', () => {
  it('caches suggest results per normalized query (one call for repeats)', async () => {
    const suggest = vi.fn().mockResolvedValue([{ lat: 1, lng: 2, label: 'Delhi' }]);
    const base: GeoProvider = { suggest, geocode: vi.fn() };
    const cached = withGeoCache(base);
    await cached.suggest('Delhi');
    await cached.suggest(' delhi ');
    expect(suggest).toHaveBeenCalledTimes(1);
  });

  it('caches geocode results per normalized query (one call for repeats)', async () => {
    const geocode = vi.fn().mockResolvedValue({ lat: 1, lng: 2 });
    const base: GeoProvider = { suggest: vi.fn(), geocode };
    const cached = withGeoCache(base);
    await cached.geocode('Mumbai');
    await cached.geocode('MUMBAI');
    expect(geocode).toHaveBeenCalledTimes(1);
  });

  it('does not cache a null geocode (transient/no-match) — retries', async () => {
    const geocode = vi.fn().mockResolvedValue(null);
    const base: GeoProvider = { suggest: vi.fn(), geocode };
    const cached = withGeoCache(base);
    await cached.geocode('Ghosttown');
    await cached.geocode('Ghosttown');
    expect(geocode).toHaveBeenCalledTimes(2);
  });

  it('keeps suggest and geocode caches independent', async () => {
    const suggest = vi.fn().mockResolvedValue([{ lat: 1, lng: 2, label: 'X' }]);
    const geocode = vi.fn().mockResolvedValue({ lat: 3, lng: 4 });
    const base: GeoProvider = { suggest, geocode };
    const cached = withGeoCache(base);
    await cached.suggest('Delhi');
    await cached.geocode('Delhi');
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(geocode).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter ui exec vitest run src/lib/geo/geo-cache.test.ts`
Expected: FAIL — `withGeoCache` is not exported.

- [ ] **Step 3: Implement `withGeoCache`**

Add to `apps/ui/src/lib/geo/geo-cache.ts` (import at top, function at bottom):

```ts
import type { GeoProvider, GeoSuggestion, LatLng } from './types';
```

```ts
/**
 * Wraps a GeoProvider so `suggest`/`geocode` are transparently session-cached
 * (see memoizeGeoLookup). suggest results are cached only when non-empty and
 * geocode results only when non-null, so a transient empty/error result is not
 * stuck for the session.
 */
export function withGeoCache(base: GeoProvider): GeoProvider {
  const cachedSuggest = memoizeGeoLookup<GeoSuggestion[]>(
    (q) => base.suggest(q),
    (results) => results.length > 0,
  );
  const cachedGeocode = memoizeGeoLookup<LatLng | null>(
    (q) => base.geocode(q),
    (result) => result !== null,
  );
  return {
    suggest: (query, signal) => cachedSuggest(query, signal),
    geocode: (address, signal) => cachedGeocode(address, signal),
  };
}
```

- [ ] **Step 4: Wire it into `getGeoProvider`**

In `apps/ui/src/lib/geo/provider.ts`, add the import:

```ts
import { withGeoCache } from './geo-cache';
```

Then wrap the constructed provider with the cache BEFORE the PII-mask guard, so masked queries still short-circuit without touching the cache. Replace the body of `getGeoProvider` from the `const base = ...` line through the `cached = {...}` assignment with:

```ts
  const base = withGeoCache(
    apiKey
      ? createGooglePlacesProvider(apiKey)
      : createPhotonProvider(photonUrl || undefined),
  );
  cached = {
    suggest: (query, signal) =>
      looksLikePIIMask(query) ? Promise.resolve([]) : base.suggest(query, signal),
    geocode: (address, signal) =>
      looksLikePIIMask(address) ? Promise.resolve(null) : base.geocode(address, signal),
  };
```

- [ ] **Step 5: Run tests + typecheck**

Run: `pnpm --filter ui exec vitest run src/lib/geo/geo-cache.test.ts`
Expected: PASS (all 11 cases).

Run: `pnpm typecheck`
Expected: PASS (api + ui).

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/geo/geo-cache.ts apps/ui/src/lib/geo/geo-cache.test.ts apps/ui/src/lib/geo/provider.ts
git commit -m "feat(ui): cache client geocoding behind getGeoProvider (#196 companion)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Remove dead `useConsentGate` + disable global focus-refetch

**Files:**
- Delete: `apps/ui/src/hooks/use-consent-gate.ts`
- Modify: `apps/ui/src/lib/consent-api.ts:38-43` (remove `getConsentStatus`)
- Modify: `apps/ui/src/main.tsx:13` (`refetchOnWindowFocus: false`)

**Interfaces:**
- Produces: nothing new. Removes `useConsentGate` and `getConsentStatus` from the module surface; `getConsentStatusByIdentifier` and all other consent-api exports remain.

- [ ] **Step 1: Confirm the removals are safe (zero importers)**

Run: `grep -rn "useConsentGate\|getConsentStatus\b" apps/ui/src | grep -v node_modules | grep -v "getConsentStatusByIdentifier"`
Expected: only `apps/ui/src/hooks/use-consent-gate.ts` (the definition) and `apps/ui/src/lib/consent-api.ts` (the definition) appear — no external importers. If anything else appears, STOP and report (the assumption is wrong).

- [ ] **Step 2: Delete the dead hook**

```bash
git rm apps/ui/src/hooks/use-consent-gate.ts
```

- [ ] **Step 3: Remove `getConsentStatus` from `consent-api.ts`**

Delete exactly this block in `apps/ui/src/lib/consent-api.ts` (keep `getConsentStatusByIdentifier` immediately below it, and keep the `ConsentStatusResponse` type — it's still used by `getConsentStatusByIdentifier`):

```ts
export async function getConsentStatus(networkId: string): Promise<ConsentStatusResponse> {
  const response = await apiClient.get<ConsentStatusResponse>('/api/v1/consent/status', {
    params: { network: networkId },
  });
  return response.data;
}
```

- [ ] **Step 4: Disable global `refetchOnWindowFocus`**

In `apps/ui/src/main.tsx`, change the queries default `refetchOnWindowFocus: true` to `false`:

```ts
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 0,
      refetchOnWindowFocus: false,
      retry: 2,
    },
  },
});
```

(Leave `staleTime: 0` as-is — the staleTime tier policy is Plan 2b / Part C. Actions freshness is unaffected: it uses `refetchInterval`, not focus.)

- [ ] **Step 5: Verify (typecheck + full UI suite + no dangling references)**

Run: `grep -rn "useConsentGate\|getConsentStatus\b" apps/ui/src | grep -v node_modules | grep -v getConsentStatusByIdentifier`
Expected: NO output (both symbols fully gone).

Run: `pnpm typecheck`
Expected: PASS — a dangling import to either deleted symbol would fail the build; clean means no dangling references.

Run: `pnpm --filter ui test`
Expected: PASS — full UI suite green (no test depended on the deleted hook/function; `login-page.test.tsx` uses `getConsentStatusByIdentifier`, which is untouched).

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/lib/consent-api.ts apps/ui/src/main.tsx
git commit -m "chore(ui): remove dead useConsentGate/getConsentStatus; disable global refetchOnWindowFocus

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (caching spec Part B + §3.2 + §3.3):**
- Part B server→ N/A (that's #196, done). Part B *client* cache: Tasks 1–2 (memoizer + provider wrap; covers autocomplete widgets, map marker geocode, and profile-form submit-time suggest via the shared `getGeoProvider` singleton). ✅
- In-flight dedup, LRU cap, normalized key, session-only, don't-cache-empty: Tasks 1–2 tests. ✅
- §3.2 disable `refetchOnWindowFocus`: Task 3 Step 4. ✅
- §3.3 delete dead `useConsentGate` (+ `getConsentStatus`): Task 3 Steps 2–3. ✅
- Deferred (documented): §3.1 schemaCache replacement → Plan 2b; Part C → Plan 2b.

**Placeholder scan:** none — full code and exact commands in every step.

**Type consistency:** `memoizeGeoLookup(fn, shouldCache, cap?)` signature used identically in Task 1 (produce) and Task 2 (consume); `withGeoCache` returns `GeoProvider`; `GeoSuggestion`/`LatLng` match `types.ts`.

## Notes for Plan 2b (Part C + schemaCache §3.1)
- Introduce `createQueryClient()` shared by `main.tsx` + `tourist/main.tourist.tsx`; it will own `refetchOnWindowFocus: false` (Task 3 here only flips the flag on the existing inline client) and the staleTime tiers.
- The `schemaCache` replacement (network/brand key + TTL + `clearSchemaCache` wired to `NetworkThemeProvider` themeId change + logout) is authored alongside the `lib/query-keys.ts` factory so both anticipate the §8 axes (viewport bucket, offset, active profile, location source, instance URL).
