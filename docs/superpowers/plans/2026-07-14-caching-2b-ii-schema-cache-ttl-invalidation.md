# Caching Phase 2b-ii — Schema Cache TTL + Invalidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the client JSON-schema cache correct — give it a TTL and actually invalidate it on network/brand switch and on logout, so the UI stops rendering stale form/`$ref` schemas after a switch or a server-side schema redeploy.

**Architecture:** The module-level `Map` in `engine/schema/schema-loader.ts` currently never expires and is never cleared (`clearSchemaCache()` has zero live callers). Add a per-entry TTL (aligned with the 5-min config tier) enforced in `loadSchema`/`getCachedSchema`, and wire the existing `clearSchemaCache()` to run when the active network/brand changes (`NetworkThemeProvider`) and on `signOut` (`auth-context`).

**Tech Stack:** React 19 + Vite, TypeScript (ESM, strict), Vitest.

**Epic context:** Phase 2b-ii of the #203 umbrella. Implements caching-spec (`docs/superpowers/specs/2026-07-10-ui-caching-strategy-design.md`) **§3.1** (the schemaCache replacement, grouped under Part D as "the fix for the removed cache"). Phases 1, 2a, 2b-i already merged/pushed on this branch. **Remaining Part C after this:** 2b-iii (`profile-form-page` → useQuery), 2b-iv (`home-page` migration + invalidate-on-write + `cache_ttl_seconds`), 2b-v (§8 instance-URL cache-busting).

## Global Constraints

- **Branch:** all work lands on `feat/ui-caching-strategy`. Do NOT commit to `feature`/`develop`.
- **ESM only, strict TS, no `any`.** UI filenames kebab-case. No `// TODO`.
- **TTL = 5 minutes** (`5 * 60 * 1000` ms), aligning the schema cache with the config staleTime tier.
- **A cache miss must remain a pure performance concern.** Every consumer (`resolve-schema.ts`, `loadSchema`) already falls through to a fetch on miss; an expired entry must behave exactly like a miss (return `undefined` / re-fetch), never throw.
- **`clearSchemaCache()` stays idempotent and side-effect-free** (just clears the Map) — safe to call on first mount (empty cache) and repeatedly.
- **Do not change the cache KEY scheme** (still keyed by `$ref`/URL). Correctness on network/brand switch comes from clearing, not re-keying — simpler and matches how the cache is consumed (`resolve-schema.ts` keys by `$ref`).

## File Structure

- `apps/ui/src/engine/schema/schema-loader.ts` — **modify**: entries become `{ schema, expiresAt }`; TTL enforced in `loadSchema`/`getCachedSchema`; `setCachedSchema` stamps expiry.
- `apps/ui/src/engine/schema/schema-loader.test.ts` — **create**: TTL behavior (hit before expiry, miss after).
- `apps/ui/src/theme/theme-provider.tsx` — **modify**: clear the schema cache when `themeId`/`brand` changes.
- `apps/ui/src/contexts/auth-context.tsx` — **modify**: clear the schema cache on `signOut`.
- `apps/ui/src/contexts/auth-context.test.tsx` — **create** (or extend if exists): assert `signOut` clears the schema cache.

---

### Task 1: TTL on the schema cache

**Files:**
- Modify: `apps/ui/src/engine/schema/schema-loader.ts`
- Create: `apps/ui/src/engine/schema/schema-loader.test.ts`

**Interfaces:**
- Unchanged public signatures: `loadSchema(input): Promise<JsonSchema>`, `getCachedSchema(key: string): JsonSchema | undefined`, `setCachedSchema(key: string, schema: JsonSchema): void`, `clearSchemaCache(): void`.
- Internal change only: the backing map stores `{ schema: JsonSchema; expiresAt: number }`; entries older than the TTL are treated as absent.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/engine/schema/schema-loader.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getCachedSchema, setCachedSchema, clearSchemaCache } from './schema-loader';
import type { RJSFSchema } from '@rjsf/utils';

const schema: RJSFSchema = { type: 'object', properties: { a: { type: 'string' } } };

describe('schema cache TTL', () => {
  beforeEach(() => {
    clearSchemaCache();
    vi.useRealTimers();
  });

  it('returns a cached schema before the TTL elapses', () => {
    vi.useFakeTimers();
    setCachedSchema('k', schema);
    vi.advanceTimersByTime(4 * 60 * 1000); // 4 min < 5 min TTL
    expect(getCachedSchema('k')).toEqual(schema);
  });

  it('treats an entry past the TTL as a miss', () => {
    vi.useFakeTimers();
    setCachedSchema('k', schema);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1); // just past TTL
    expect(getCachedSchema('k')).toBeUndefined();
  });

  it('clearSchemaCache drops entries', () => {
    setCachedSchema('k', schema);
    clearSchemaCache();
    expect(getCachedSchema('k')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/engine/schema/schema-loader.test.ts`
Expected: FAIL — the "past the TTL" test fails (current cache never expires, returns the schema).

- [ ] **Step 3: Add the TTL to `schema-loader.ts`**

In `apps/ui/src/engine/schema/schema-loader.ts`:

Change the cache type and add the TTL constant (near the top, replacing `const schemaCache = new Map<string, JsonSchema>();`):

```ts
const SCHEMA_CACHE_TTL_MS = 5 * 60 * 1000; // 5 min — aligns with the config staleTime tier

interface CacheEntry {
  schema: JsonSchema;
  expiresAt: number;
}

const schemaCache = new Map<string, CacheEntry>();

/** Returns a live (non-expired) entry's schema, deleting it if expired. */
function readFresh(key: string): JsonSchema | undefined {
  const entry = schemaCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    schemaCache.delete(key);
    return undefined;
  }
  return entry.schema;
}
```

In `loadSchema`, replace the hit check `if (cacheKey && schemaCache.has(cacheKey)) { return schemaCache.get(cacheKey)!; }` with:

```ts
  if (cacheKey) {
    const fresh = readFresh(cacheKey);
    if (fresh !== undefined) return fresh;
  }
```

And replace the store `schemaCache.set(cacheKey, schema);` with:

```ts
    schemaCache.set(cacheKey, { schema, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS });
```

Update the accessors:

```ts
export function getCachedSchema(key: string): JsonSchema | undefined {
  return readFresh(key);
}

export function setCachedSchema(key: string, schema: JsonSchema): void {
  schemaCache.set(key, { schema, expiresAt: Date.now() + SCHEMA_CACHE_TTL_MS });
}
```

`clearSchemaCache()` stays `schemaCache.clear();`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/engine/schema/schema-loader.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify no regression**

Run: `pnpm typecheck`
Expected: PASS (the `CacheEntry` change is internal; public signatures unchanged).

Run: `pnpm --filter ui test`
Expected: PASS — full UI suite green (schema resolution via `resolve-schema.ts` still works; within a test run nothing waits 5 min so all entries are fresh).

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/engine/schema/schema-loader.ts apps/ui/src/engine/schema/schema-loader.test.ts
git commit -m "feat(ui): TTL the client schema cache (5 min)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Invalidate the schema cache on network/brand switch and logout

**Files:**
- Modify: `apps/ui/src/theme/theme-provider.tsx` (the `themeId`/`activeBrand` effect around lines 207-209)
- Modify: `apps/ui/src/contexts/auth-context.tsx:57-64` (`signOut`)
- Create: `apps/ui/src/contexts/auth-context.test.tsx`

**Interfaces:**
- Consumes: `clearSchemaCache` from `@/engine` (re-exported there from `schema-loader.ts`).
- No new exports; behavior change only (cache is cleared on the two events).

- [ ] **Step 1: Write the failing test (logout clears the cache)**

Create `apps/ui/src/contexts/auth-context.test.tsx`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './auth-context';

const { clearSchemaCache } = vi.hoisted(() => ({ clearSchemaCache: vi.fn() }));
vi.mock('@/engine', () => ({ clearSchemaCache }));
vi.mock('@/lib/auth-api', () => ({
  getSession: vi.fn().mockResolvedValue(null),
  signOut: vi.fn().mockResolvedValue(undefined),
}));

describe('AuthProvider signOut', () => {
  beforeEach(() => clearSchemaCache.mockClear());

  it('clears the schema cache on sign-out', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper: AuthProvider });
    await act(async () => { await result.current.signOut(); });
    expect(clearSchemaCache).toHaveBeenCalled();
  });
});
```

> If `auth-context.tsx` imports `getSession`/`signOut` from `@/lib/auth-api` under different names or needs more of that module mocked for `AuthProvider` to mount, extend the `@/lib/auth-api` mock to cover what the provider calls on mount (check its imports first) — do not leave the provider unable to render.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/contexts/auth-context.test.tsx`
Expected: FAIL — `clearSchemaCache` not called on sign-out yet.

- [ ] **Step 3: Wire `clearSchemaCache` into `signOut`**

In `apps/ui/src/contexts/auth-context.tsx`, add the import:

```ts
import { clearSchemaCache } from '@/engine';
```

Then in `signOut`, clear the cache in the `finally` (schemas are network/brand-scoped and a different user may resolve a different network):

```ts
  const signOut = useCallback(async () => {
    try {
      await apiSignOut();
    } finally {
      clearAuthToken();
      setUser(null);
      clearSchemaCache();
    }
  }, []);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/contexts/auth-context.test.tsx`
Expected: PASS.

- [ ] **Step 5: Clear the schema cache on network/brand switch**

In `apps/ui/src/theme/theme-provider.tsx`, add the import:

```ts
import { clearSchemaCache } from '@/engine';
```

Add an effect that clears the schema cache whenever the active network or brand changes (place it near the existing `useLayoutEffect` that calls `applyThemeTokens(themeId, activeBrand)`):

```ts
  React.useEffect(() => {
    // Resolved schemas ($ref-keyed) are network/brand-specific; a switch must
    // drop them so the new network's forms/refs are re-fetched, not served
    // stale from the previous network. Clearing an already-empty cache on first
    // mount is a no-op.
    clearSchemaCache();
  }, [themeId, activeBrand]);
```

(Use `React.useEffect` to match the file's `React.*` usage; if the file imports hooks by name, use the matching `useEffect` form.)

- [ ] **Step 6: Verify**

Run: `pnpm typecheck`
Expected: PASS.

Run: `pnpm --filter ui test`
Expected: PASS — full UI suite green (the added effect clears an empty cache on mount in tests; no behavior any existing test asserts changes).

- [ ] **Step 7: Commit**

```bash
git add apps/ui/src/theme/theme-provider.tsx apps/ui/src/contexts/auth-context.tsx apps/ui/src/contexts/auth-context.test.tsx
git commit -m "feat(ui): clear schema cache on network/brand switch and logout

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage (§3.1):** TTL → Task 1; invalidate on network/brand switch → Task 2 Step 5; invalidate on logout → Task 2 Steps 3-4. The spec also mentions "network/brand-keyed"; this plan achieves the same correctness by clearing on switch instead of re-keying (documented in Global Constraints) — simpler and consistent with how `resolve-schema.ts` keys by `$ref`. No other §3.1 requirement outstanding.

**Placeholder scan:** none — full code + exact commands. The two conditional instructions (auth-api mock surface; `useEffect` import form) carry explicit grounding steps, not guesses.

**Type consistency:** `CacheEntry { schema, expiresAt }` used consistently; public accessor signatures unchanged (`getCachedSchema`/`setCachedSchema`/`clearSchemaCache`); `readFresh` returns `JsonSchema | undefined` matching `getCachedSchema`.

**Behavior check:** an expired entry behaves exactly like a miss (callers already fetch on miss); `clearSchemaCache` on mount is a no-op on an empty cache; no public API changed.

## Notes for later Part-C plans
- 2b-iii: migrate `profile-form-page.tsx` fetches (networks list 103-122, network config 134-155, edit lookup 158-210, domain-lock probe 220-246) to `useQuery` using `queryKeys` + the config/own-data tiers.
- 2b-iv: migrate `home-page.tsx` (config 250-302, my-profiles 321-385, browse 556-594) — the coupled one; recompute `activeProfileId`/`consentedProfileIds`/`profilesResolved` from query data. Add invalidate-on-write (createItem/updateItem → `queryKeys.myItems` + `queryKeys.browseItems`; performAction(s) → `queryKeys.actions.all`; consent-accept → invalidate instead of the local Set) and pass `cache_ttl_seconds` on the browse query.
- 2b-v: §8 instance-URL busting — add `selectedApiUrl` to browse/my-items/markers/schema keys and clear caches on instance switch (`api-config.setSelectedKey`), since `createApiClient` captures `baseURL` at construction.
