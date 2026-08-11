# #196 Server Geocoding Cache — Implementation Plan (Phase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put a Redis places cache in front of the server geocoder so identical place strings don't re-hit the paid Google Geocoding API.

**Architecture:** A best-effort get-or-load-and-set wrapper (mirroring `apps/api/src/utils/item_fetch_cache.ts`) sits at the single geocode choke point `resolveCoordinates(query)` in `geo_resolver.ts`. Positive results cache for a long TTL, unresolvable strings cache briefly as a sentinel, and any Redis error falls through to a live provider call. Two configurable TTLs are added to the existing `GeocodingSecretsSchema`.

**Tech Stack:** Fastify/Node API, TypeScript (ESM, strict, no `any`), Zod env schemas (`@dpg/config`), ioredis (`@api/db/secondary/redis`), Vitest.

**Epic context:** This is Phase 1 of the #203 umbrella (`docs/superpowers/specs/2026-07-13-ui-data-fetching-at-scale-design.md`), implementing caching-spec Part A (`docs/superpowers/specs/2026-07-10-ui-caching-strategy-design.md` §4.A). Closes issue #196.

## Global Constraints

- **Branch:** all work lands on `feat/ui-caching-strategy`. Do NOT commit to `feature` or `develop`.
- **ESM only, strict TS, no `any`.** Use `import type` for type-only imports. Files are snake_case.
- **No `// TODO` comments** — open an issue instead.
- **Env vars change two places together:** the Zod schema in `packages/config/src/secrets.ts` AND `turbo.json` `globalPassThroughEnv` (else it fails under `pnpm dev:api`).
- **Cache value shape = the current `resolveCoordinates` result** — `{ lat: number; lng: number } | null` (`Coordinates`). The issue text mentions `city/state/country`, but the resolver returns only `{lat,lng}` today; do NOT invent fields — cache exactly what the resolver returns.
- **Best-effort caching:** a Redis get/set error must never fail a resolve — fall through to the live provider call.
- **TTL defaults:** positive `GEO_CACHE_TTL_SECONDS` = `2592000` (30 days); negative `GEO_CACHE_NEGATIVE_TTL_SECONDS` = `3600` (1 hour).

---

## File Structure

- `packages/config/src/secrets.ts` — **modify**: add two TTL fields to `GeocodingSecretsSchema`.
- `packages/config/src/__tests__/geocoding_secrets.test.ts` — **modify**: assert the new defaults / coercion.
- `apps/api/src/config.ts` — **modify**: expose the two TTLs on `geocodingConfig`.
- `turbo.json` — **modify**: add the two env vars to `globalPassThroughEnv`.
- `apps/api/src/services/geocoding/geo_cache.ts` — **create**: `normalizeGeoKey`, `buildGeoCacheKey`, `getCachedCoordinates`.
- `apps/api/src/services/geocoding/__tests__/geo_cache.test.ts` — **create**: unit tests for the helpers + wrapper.
- `apps/api/src/services/geocoding/geo_resolver.ts` — **modify**: route `resolveCoordinates` through the cache.
- `apps/api/src/services/geocoding/__tests__/resolve_coordinates_cache.test.ts` — **create**: end-to-end "repeat lookup = one provider call".

---

### Task 1: Configurable cache TTL env vars

**Files:**
- Modify: `packages/config/src/secrets.ts` (`GeocodingSecretsSchema`, the `.object({...})` block ending at the `PII_LOCATION_JITTER_MAX_METERS` line)
- Modify: `packages/config/src/__tests__/geocoding_secrets.test.ts`
- Modify: `apps/api/src/config.ts:64-69` (`geocodingConfig`)
- Modify: `turbo.json` (`globalPassThroughEnv` array)

**Interfaces:**
- Produces: `GeocodingSecretsSchema` gains `GEO_CACHE_TTL_SECONDS: number` (default 2592000) and `GEO_CACHE_NEGATIVE_TTL_SECONDS: number` (default 3600). `geocodingConfig` gains `cache_ttl_seconds: number` and `cache_negative_ttl_seconds: number`.

- [ ] **Step 1: Write the failing test**

Add to `packages/config/src/__tests__/geocoding_secrets.test.ts` (new `describe` block at end of file):

```ts
describe('GeocodingSecretsSchema cache TTLs', () => {
  it('defaults to 30 days positive / 1 hour negative when unset', () => {
    const parsed = GeocodingSecretsSchema.parse({});
    expect(parsed.GEO_CACHE_TTL_SECONDS).toBe(2592000);
    expect(parsed.GEO_CACHE_NEGATIVE_TTL_SECONDS).toBe(3600);
  });

  it('coerces string env values to numbers', () => {
    const parsed = GeocodingSecretsSchema.parse({
      GEO_CACHE_TTL_SECONDS: '600',
      GEO_CACHE_NEGATIVE_TTL_SECONDS: '120',
    });
    expect(parsed.GEO_CACHE_TTL_SECONDS).toBe(600);
    expect(parsed.GEO_CACHE_NEGATIVE_TTL_SECONDS).toBe(120);
  });

  it('rejects a non-positive TTL', () => {
    expect(() =>
      GeocodingSecretsSchema.parse({ GEO_CACHE_TTL_SECONDS: '0' }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter config exec vitest run src/__tests__/geocoding_secrets.test.ts`
Expected: FAIL — `expected undefined to be 2592000` (fields not defined yet).

- [ ] **Step 3: Add the fields to the schema**

In `packages/config/src/secrets.ts`, inside the `GeocodingSecretsSchema` `.object({...})`, add after the `PII_LOCATION_JITTER_MAX_METERS` line (still inside the object, before the closing `})`):

```ts
    // Places cache TTLs (#196). Positive results are stable → long TTL;
    // unresolvable strings cache briefly so they don't hammer the paid API.
    GEO_CACHE_TTL_SECONDS: z.coerce.number().int().positive().default(2592000),
    GEO_CACHE_NEGATIVE_TTL_SECONDS: z.coerce.number().int().positive().default(3600),
```

- [ ] **Step 4: Expose them on `geocodingConfig`**

In `apps/api/src/config.ts`, extend the `geocodingConfig` object:

```ts
export const geocodingConfig = {
  google_api_key: geocoding.GOOGLE_GEOCODING_API_KEY,
  photon_url: geocoding.PHOTON_URL ?? 'https://photon.komoot.io',
  jitter_min_meters: geocoding.PII_LOCATION_JITTER_MIN_METERS,
  jitter_max_meters: geocoding.PII_LOCATION_JITTER_MAX_METERS,
  cache_ttl_seconds: geocoding.GEO_CACHE_TTL_SECONDS,
  cache_negative_ttl_seconds: geocoding.GEO_CACHE_NEGATIVE_TTL_SECONDS,
};
```

- [ ] **Step 5: Add the env vars to `turbo.json` passthrough**

In `turbo.json`, add these two entries to the `globalPassThroughEnv` array (near the existing `GOOGLE_GEOCODING_API_KEY` / `PHOTON_URL` entries):

```json
    "GEO_CACHE_TTL_SECONDS",
    "GEO_CACHE_NEGATIVE_TTL_SECONDS",
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter config exec vitest run src/__tests__/geocoding_secrets.test.ts`
Expected: PASS (all cache-TTL + existing jitter tests green).

- [ ] **Step 7: Commit**

```bash
git add packages/config/src/secrets.ts packages/config/src/__tests__/geocoding_secrets.test.ts apps/api/src/config.ts turbo.json
git commit -m "feat(api): add configurable geocoding cache TTL env vars (#196)"
```

---

### Task 2: Cache-key normalization helpers

**Files:**
- Create: `apps/api/src/services/geocoding/geo_cache.ts`
- Create: `apps/api/src/services/geocoding/__tests__/geo_cache.test.ts`

**Interfaces:**
- Produces: `normalizeGeoKey(query: string): string` (lowercase + trim + collapse internal whitespace) and `buildGeoCacheKey(query: string): string` (returns `geo:place:<normalized>`).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/geocoding/__tests__/geo_cache.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

// geo_cache imports the Redis client and config at module load; mock both so
// the unit test never opens a socket or runs loadEnv().
vi.mock('@api/db/secondary/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@/config', () => ({
  geocodingConfig: { cache_ttl_seconds: 2592000, cache_negative_ttl_seconds: 3600 },
}));

import { normalizeGeoKey, buildGeoCacheKey } from '../geo_cache.js';

describe('normalizeGeoKey', () => {
  it('lowercases, trims, and collapses internal whitespace', () => {
    expect(normalizeGeoKey('  Noida,   Uttar   Pradesh ')).toBe('noida, uttar pradesh');
  });

  it('is stable across case/spacing variants', () => {
    expect(normalizeGeoKey('GHAZIABAD')).toBe(normalizeGeoKey('  ghaziabad '));
  });
});

describe('buildGeoCacheKey', () => {
  it('prefixes the normalized query with geo:place:', () => {
    expect(buildGeoCacheKey(' Noida ')).toBe('geo:place:noida');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/geo_cache.test.ts`
Expected: FAIL — cannot find module `../geo_cache.js` / exports undefined.

- [ ] **Step 3: Create the helpers**

Create `apps/api/src/services/geocoding/geo_cache.ts`:

```ts
/**
 * Normalize a place query so case/spacing variants share one cache entry:
 * trim, lowercase, and collapse internal whitespace runs to a single space.
 */
export function normalizeGeoKey(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Redis key for a resolved place: `geo:place:<normalized query>`. */
export function buildGeoCacheKey(query: string): string {
  return `geo:place:${normalizeGeoKey(query)}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/geo_cache.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/geocoding/geo_cache.ts apps/api/src/services/geocoding/__tests__/geo_cache.test.ts
git commit -m "feat(api): add geocoding cache-key normalization helpers (#196)"
```

---

### Task 3: `getCachedCoordinates` best-effort wrapper

**Files:**
- Modify: `apps/api/src/services/geocoding/geo_cache.ts`
- Modify: `apps/api/src/services/geocoding/__tests__/geo_cache.test.ts`

**Interfaces:**
- Consumes: `buildGeoCacheKey` (Task 2); `redis` from `@api/db/secondary/redis`; `geocodingConfig.{cache_ttl_seconds,cache_negative_ttl_seconds}` (Task 1); `Coordinates` type from `./geo_resolver`.
- Produces: `getCachedCoordinates(query: string, loader: () => Promise<Coordinates | null>): Promise<Coordinates | null>` — returns cached coords on hit, `null` on a cached negative, otherwise calls `loader()` and stores the result (positive or negative sentinel). Any Redis error falls through to `loader()`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/src/services/geocoding/__tests__/geo_cache.test.ts`. First, update the redis mock at the top of the file to expose controllable fns via `vi.hoisted` (replace the existing `vi.mock('@api/db/secondary/redis', ...)` line):

```ts
const { get, set } = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@api/db/secondary/redis', () => ({ redis: { get, set } }));
```

Add `beforeEach` to the existing top-of-file vitest import (so it reads `import { describe, it, expect, vi, beforeEach } from 'vitest';`), then append the import and tests:

```ts
import { getCachedCoordinates } from '../geo_cache.js';

describe('getCachedCoordinates', () => {
  beforeEach(() => { get.mockReset(); set.mockReset(); });

  it('returns cached coords on a positive hit without calling the loader', async () => {
    get.mockResolvedValueOnce(JSON.stringify({ lat: 12.97, lng: 77.59 }));
    const loader = vi.fn();
    const result = await getCachedCoordinates('Bengaluru', loader);
    expect(result).toEqual({ lat: 12.97, lng: 77.59 });
    expect(loader).not.toHaveBeenCalled();
    expect(set).not.toHaveBeenCalled();
  });

  it('returns null on a cached negative sentinel without calling the loader', async () => {
    get.mockResolvedValueOnce('__no_result__');
    const loader = vi.fn();
    const result = await getCachedCoordinates('Nowhere', loader);
    expect(result).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('on a miss, calls the loader and stores a positive result with the long TTL', async () => {
    get.mockResolvedValueOnce(null);
    const loader = vi.fn().mockResolvedValue({ lat: 1, lng: 2 });
    const result = await getCachedCoordinates('Noida', loader);
    expect(result).toEqual({ lat: 1, lng: 2 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith('geo:place:noida', JSON.stringify({ lat: 1, lng: 2 }), 'EX', 2592000);
  });

  it('on a miss that resolves to null, stores the sentinel with the negative TTL', async () => {
    get.mockResolvedValueOnce(null);
    const loader = vi.fn().mockResolvedValue(null);
    const result = await getCachedCoordinates('Gibberish', loader);
    expect(result).toBeNull();
    expect(set).toHaveBeenCalledWith('geo:place:gibberish', '__no_result__', 'EX', 3600);
  });

  it('falls through to the loader when Redis get throws', async () => {
    get.mockRejectedValueOnce(new Error('redis down'));
    const loader = vi.fn().mockResolvedValue({ lat: 3, lng: 4 });
    const result = await getCachedCoordinates('Delhi', loader);
    expect(result).toEqual({ lat: 3, lng: 4 });
    expect(loader).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/geo_cache.test.ts`
Expected: FAIL — `getCachedCoordinates` is not exported.

- [ ] **Step 3: Implement the wrapper**

Add to `apps/api/src/services/geocoding/geo_cache.ts` (imports at top of file, function below the helpers):

```ts
import { redis } from '@api/db/secondary/redis';
import { geocodingConfig } from '@/config';
import type { Coordinates } from './geo_resolver';

/**
 * Sentinel stored for a query that resolved to nothing, so unresolvable
 * strings are not re-sent to the paid provider every time. Distinct from a
 * Redis miss (absent key → `redis.get` returns `null`).
 */
const GEO_NEGATIVE_SENTINEL = '__no_result__';

/**
 * Best-effort Redis get-or-load-and-set around a geocode. Caches positive
 * results for the long TTL and negative results briefly. Any Redis error
 * falls through to a live `loader()` call and never throws.
 */
export async function getCachedCoordinates(
  query: string,
  loader: () => Promise<Coordinates | null>,
): Promise<Coordinates | null> {
  const cacheKey = buildGeoCacheKey(query);

  try {
    const cached = await redis.get(cacheKey);
    if (cached === GEO_NEGATIVE_SENTINEL) return null;
    if (cached !== null) return JSON.parse(cached) as Coordinates;
  } catch {
    // Redis unavailable → resolve live, skip caching this round.
    return loader();
  }

  const result = await loader();

  try {
    if (result === null) {
      await redis.set(cacheKey, GEO_NEGATIVE_SENTINEL, 'EX', geocodingConfig.cache_negative_ttl_seconds);
    } else {
      await redis.set(cacheKey, JSON.stringify(result), 'EX', geocodingConfig.cache_ttl_seconds);
    }
  } catch {
    // Storing is best-effort; a write failure must not fail the resolve.
  }

  return result;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/geo_cache.test.ts`
Expected: PASS (all Task 2 + Task 3 cases green).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/geocoding/geo_cache.ts apps/api/src/services/geocoding/__tests__/geo_cache.test.ts
git commit -m "feat(api): add best-effort geocoding cache wrapper (#196)"
```

---

### Task 4: Route `resolveCoordinates` through the cache

**Files:**
- Modify: `apps/api/src/services/geocoding/geo_resolver.ts:58-69`
- Modify: `apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts` (add module mocks so the transitive redis import stays hermetic)
- Create: `apps/api/src/services/geocoding/__tests__/resolve_coordinates_cache.test.ts`

**Interfaces:**
- Consumes: `getCachedCoordinates` (Task 3).
- Produces: `resolveCoordinates(query: string): Promise<Coordinates | null>` — unchanged signature; now cache-backed. `Coordinates` interface unchanged.

- [ ] **Step 1: Write the failing end-to-end test**

Create `apps/api/src/services/geocoding/__tests__/resolve_coordinates_cache.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stateful in-memory Redis so a stored value is visible to the next get —
// proves a repeat lookup is served from cache (no second provider call).
const store = new Map<string, string>();
const get = vi.fn(async (k: string) => store.get(k) ?? null);
const set = vi.fn(async (k: string, v: string) => { store.set(k, v); return 'OK'; });
vi.mock('@api/db/secondary/redis', () => ({ redis: { get, set } }));
vi.mock('@/config', () => ({
  geocodingConfig: {
    google_api_key: 'test-key',
    photon_url: 'https://photon.example',
    cache_ttl_seconds: 2592000,
    cache_negative_ttl_seconds: 3600,
  },
}));

import { resolveCoordinates } from '../geo_resolver.js';

const googleOk = {
  ok: true,
  json: async () => ({ status: 'OK', results: [{ geometry: { location: { lat: 12.97, lng: 77.59 } } }] }),
};

beforeEach(() => { store.clear(); get.mockClear(); set.mockClear(); });

describe('resolveCoordinates caching (#196)', () => {
  it('calls the provider once for repeated identical lookups', async () => {
    const fetchMock = vi.fn().mockResolvedValue(googleOk);
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveCoordinates('Bengaluru');
    const second = await resolveCoordinates('  BENGALURU ');

    expect(first).toEqual({ lat: 12.97, lng: 77.59 });
    expect(second).toEqual({ lat: 12.97, lng: 77.59 });
    expect(fetchMock).toHaveBeenCalledTimes(1); // second served from cache
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/resolve_coordinates_cache.test.ts`
Expected: FAIL — `fetch` called twice (no cache yet).

- [ ] **Step 3: Wire `resolveCoordinates` to the cache**

In `apps/api/src/services/geocoding/geo_resolver.ts`, add the import at the top:

```ts
import { getCachedCoordinates } from './geo_cache';
```

Then replace the `resolveCoordinates` function (lines 53-69) with a provider-dispatch helper plus a cache-backed public entry:

```ts
/** Dispatch to the configured provider. Best-effort — returns null on error. */
async function resolveFromProvider(q: string): Promise<Coordinates | null> {
  try {
    if (geocodingConfig.google_api_key) {
      return await resolveWithGoogle(q, geocodingConfig.google_api_key);
    }
    return await resolveWithPhoton(q, geocodingConfig.photon_url);
  } catch {
    return null;
  }
}

/**
 * Server-side resolve of a composite address string to coordinates, cached in
 * Redis (#196). Google Geocoding when a key is configured, else Photon.
 * Returns null on any failure — callers must treat geocoding as best-effort.
 */
export async function resolveCoordinates(query: string): Promise<Coordinates | null> {
  const q = query.trim();
  if (!q) return null;
  return getCachedCoordinates(q, () => resolveFromProvider(q));
}
```

- [ ] **Step 4: Keep the existing resolver test hermetic**

`geo_resolver.test.ts` now transitively imports `geo_cache` → the Redis client. Add these mocks at the very top of `apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts` (above the existing imports) so it never opens a socket:

```ts
import { vi } from 'vitest';
vi.mock('@api/db/secondary/redis', () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock('@/config', () => ({
  geocodingConfig: { cache_ttl_seconds: 2592000, cache_negative_ttl_seconds: 3600 },
}));
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/resolve_coordinates_cache.test.ts`
Expected: PASS — `fetch` called exactly once.

- [ ] **Step 6: Run the full geocoding suite + typecheck (acceptance)**

Run: `pnpm --filter api exec vitest run src/services/geocoding`
Expected: PASS — the new cache tests plus the existing `geo_resolver.test.ts`, `resolve_locations_for_create.test.ts`, `jitter.test.ts` all green.

Run: `pnpm typecheck`
Expected: PASS — no type errors (api tsc + ui tsc).

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/geocoding/geo_resolver.ts apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts apps/api/src/services/geocoding/__tests__/resolve_coordinates_cache.test.ts
git commit -m "feat(api): cache resolved place coordinates in Redis (#196)"
```

---

## Acceptance (maps to issue #196)

- [ ] Repeat lookups of the same place do not call the provider (Task 4 asserts one `fetch` for two lookups).
- [ ] Cache hit returns the same `{lat,lng}` shape as a live call (Task 3 positive-hit test).
- [ ] Miss → call → store → subsequent same query is a hit (Task 4 end-to-end).
- [ ] Negative results cached briefly; TTLs configurable (Task 1 env + Task 3 negative-TTL test).
- [ ] Unit tests for cache hit / miss / negative-cache; existing geocoding tests still pass (Task 4, Step 6 full-suite run).
- [ ] Redis error falls through to a live call (Task 3 throw test).

## Notes for the next phase
- The client-side geocoding cache (caching-spec Part B) reuses the *concept* of `normalizeGeoKey`; it lives in `apps/ui` (separate package), so duplicate the small normalizer there rather than importing across the api/ui boundary.
- `getCachedCoordinates` stores the **pre-jitter** coordinate; PII jitter is applied downstream at the storage choke point (`jitter.ts` / `resolve_locations_for_create.ts`), so caching the exact resolved fact is correct and reusable.
