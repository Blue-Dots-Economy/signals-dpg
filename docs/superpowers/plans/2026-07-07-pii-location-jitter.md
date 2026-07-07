# PII Location Jitter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store a private (PII) primary location field as a deterministic random point within a configurable 100–250 m annulus of the true location, instead of a city centroid.

**Architecture:** One PII transform (the jitter), applied once, server-side, at the single storage choke point (`locationsForStorage` in `item_service.ts`) that every write path funnels through. The browser and bots send the exact coordinate (browser from Google autocomplete, bots via server geocode of the address); the server jitters before persisting. The old city-centroid step (`resolveCityCenter`) and the duplicated browser/server coarsening are deleted.

**Tech Stack:** TypeScript (ESM, strict), Fastify + Drizzle (api), React 19 + Vite (ui), Zod (config), Vitest. Node ≥ 24, pnpm.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md` (signals-dpg #243).
- **Deterministic jitter** seeded from the true coord rounded to 5 decimals — same input → same output; no drift on re-save.
- **Radius via global env**, defaults `PII_LOCATION_JITTER_MIN_METERS=100`, `PII_LOCATION_JITTER_MAX_METERS=250`.
- **No bypass flag** — jitter is unconditional for private fields (a flag would let a client persist an exact PII coord).
- **Never log** the exact coordinate or the address; jitter before persist/return.
- **Files are snake_case; ESM only; no `any`; use `import type` for type-only imports.** Routes never throw.
- **Public location fields unchanged** (exact). Affected networks: blue_dot seeker, yellow_dot, purple_dot seeker.
- Run api unit tests with: `pnpm --filter api exec vitest run <file>`. Run config tests with: `pnpm --filter @dpg/config exec vitest run <file>`. Typecheck: `pnpm typecheck`.
- **Two env-var places must change together:** the Zod schema in `packages/config/src/secrets.ts` AND `turbo.json` `globalPassThroughEnv`.

---

### Task 1: Jitter radius config

**Files:**
- Modify: `packages/config/src/secrets.ts:103-106` (`GeocodingSecretsSchema`)
- Modify: `apps/api/src/config.ts:42-45` (`geocodingConfig`)
- Modify: `turbo.json` (`globalPassThroughEnv`, near the existing `PHOTON_URL` entry ~line 28)
- Test: `packages/config/src/__tests__/geocoding_secrets.test.ts` (create)

**Interfaces:**
- Produces: `geocodingConfig.jitter_min_meters: number`, `geocodingConfig.jitter_max_meters: number` (consumed by Task 4).

- [ ] **Step 1: Write the failing test**

Create `packages/config/src/__tests__/geocoding_secrets.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { GeocodingSecretsSchema } from '../secrets';

describe('GeocodingSecretsSchema jitter radii', () => {
  it('defaults to 100/250 when unset', () => {
    const parsed = GeocodingSecretsSchema.parse({});
    expect(parsed.PII_LOCATION_JITTER_MIN_METERS).toBe(100);
    expect(parsed.PII_LOCATION_JITTER_MAX_METERS).toBe(250);
  });

  it('coerces string env values to numbers', () => {
    const parsed = GeocodingSecretsSchema.parse({
      PII_LOCATION_JITTER_MIN_METERS: '150',
      PII_LOCATION_JITTER_MAX_METERS: '400',
    });
    expect(parsed.PII_LOCATION_JITTER_MIN_METERS).toBe(150);
    expect(parsed.PII_LOCATION_JITTER_MAX_METERS).toBe(400);
  });

  it('rejects min greater than max', () => {
    expect(() =>
      GeocodingSecretsSchema.parse({
        PII_LOCATION_JITTER_MIN_METERS: '300',
        PII_LOCATION_JITTER_MAX_METERS: '250',
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/geocoding_secrets.test.ts`
Expected: FAIL — `PII_LOCATION_JITTER_MIN_METERS` is `undefined`.

- [ ] **Step 3: Add the fields + refinement to the schema**

In `packages/config/src/secrets.ts`, replace the `GeocodingSecretsSchema` (lines 103-106):

```typescript
export const GeocodingSecretsSchema = z
  .object({
    GOOGLE_GEOCODING_API_KEY: z.string().optional(),
    PHOTON_URL: z.string().optional(),
    // Radius of the random offset applied to a PRIVATE (PII) primary location
    // before it is stored, so the exact address is never persisted. See
    // docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
    PII_LOCATION_JITTER_MIN_METERS: z.coerce.number().positive().default(100),
    PII_LOCATION_JITTER_MAX_METERS: z.coerce.number().positive().default(250),
  })
  .refine((c) => c.PII_LOCATION_JITTER_MIN_METERS <= c.PII_LOCATION_JITTER_MAX_METERS, {
    message: 'PII_LOCATION_JITTER_MIN_METERS must be <= PII_LOCATION_JITTER_MAX_METERS',
    path: ['PII_LOCATION_JITTER_MIN_METERS'],
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @dpg/config exec vitest run src/__tests__/geocoding_secrets.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Expose the values in `geocodingConfig`**

In `apps/api/src/config.ts`, replace `geocodingConfig` (lines 42-45):

```typescript
export const geocodingConfig = {
  google_api_key: geocoding.GOOGLE_GEOCODING_API_KEY,
  photon_url: geocoding.PHOTON_URL ?? 'https://photon.komoot.io',
  jitter_min_meters: geocoding.PII_LOCATION_JITTER_MIN_METERS,
  jitter_max_meters: geocoding.PII_LOCATION_JITTER_MAX_METERS,
};
```

- [ ] **Step 6: Add both env names to `turbo.json` passthrough**

In `turbo.json` `globalPassThroughEnv`, immediately after the `"PHOTON_URL"` entry, add:

```json
    "PII_LOCATION_JITTER_MIN_METERS",
    "PII_LOCATION_JITTER_MAX_METERS",
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/config/src/secrets.ts packages/config/src/__tests__/geocoding_secrets.test.ts apps/api/src/config.ts turbo.json
git commit -m "feat(config): add PII location jitter radius env vars (#243)"
```

---

### Task 2: Pure jitter function

**Files:**
- Create: `apps/api/src/services/geocoding/jitter.ts`
- Test: `apps/api/src/services/geocoding/__tests__/jitter.test.ts` (create)

**Interfaces:**
- Produces: `jitterCoordinate(coord: JitterableCoord, minMeters: number, maxMeters: number): JitterableCoord` where `JitterableCoord = { lat: number; lng: number; label?: string }`. Deterministic for a given `(lat, lng)`; distance from the input is always in `[minMeters, maxMeters]`; `label` preserved. (Consumed by Task 4.)

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/geocoding/__tests__/jitter.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { jitterCoordinate } from '../jitter';

// Haversine distance in metres between two coords.
function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const ORIGIN = { lat: 12.9716, lng: 77.5946 }; // Bangalore

describe('jitterCoordinate', () => {
  it('offsets within [min, max] metres', () => {
    const out = jitterCoordinate(ORIGIN, 100, 250);
    const d = distanceMeters(ORIGIN, out);
    expect(d).toBeGreaterThanOrEqual(100 - 1); // ~1m tolerance for haversine vs equirect
    expect(d).toBeLessThanOrEqual(250 + 1);
  });

  it('is deterministic for the same coordinate', () => {
    expect(jitterCoordinate(ORIGIN, 100, 250)).toEqual(jitterCoordinate(ORIGIN, 100, 250));
  });

  it('produces a different point from the input', () => {
    const out = jitterCoordinate(ORIGIN, 100, 250);
    expect(out.lat === ORIGIN.lat && out.lng === ORIGIN.lng).toBe(false);
  });

  it('preserves label', () => {
    const out = jitterCoordinate({ ...ORIGIN, label: 'Home' }, 100, 250);
    expect(out.label).toBe('Home');
  });

  it('omits label when absent', () => {
    expect('label' in jitterCoordinate(ORIGIN, 100, 250)).toBe(false);
  });

  it('stays in range across many distinct points and high latitude', () => {
    for (let i = 0; i < 200; i++) {
      const c = { lat: 55 + i * 0.01, lng: -3 + i * 0.017 };
      const d = distanceMeters(c, jitterCoordinate(c, 100, 250));
      expect(d).toBeGreaterThanOrEqual(100 - 2);
      expect(d).toBeLessThanOrEqual(250 + 2);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/jitter.test.ts`
Expected: FAIL — cannot find module `../jitter`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/services/geocoding/jitter.ts`:

```typescript
/**
 * Deterministic geo-jitter for PRIVATE (PII) locations: offsets a coordinate by
 * a pseudo-random distance in [minMeters, maxMeters] at a pseudo-random bearing,
 * so the stored point is near — but never exactly on — the true location.
 *
 * Determinism (seed derived from the coordinate itself) is deliberate: the same
 * true location always maps to the same jittered point, so re-saving a profile
 * never drifts the pin and an observer cannot average repeated snapshots back to
 * the truth. See docs/superpowers/specs/2026-07-07-pii-location-jitter-design.md.
 */

export interface JitterableCoord {
  lat: number;
  lng: number;
  label?: string;
}

/** Metres per degree of latitude (constant); longitude scales by cos(lat). */
const METERS_PER_DEGREE = 111_320;

/** FNV-1a hash of a string to an unsigned 32-bit int. */
function hashStringToUint32(input: string): number {
  let h = 2_166_136_261 >>> 0;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16_777_619);
  }
  return h >>> 0;
}

/** mulberry32 PRNG — deterministic uniform [0, 1) sequence from a 32-bit seed. */
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function jitterCoordinate(
  coord: JitterableCoord,
  minMeters: number,
  maxMeters: number,
): JitterableCoord {
  // Seed from the true point rounded to ~1 m so the same address is stable.
  const seed = hashStringToUint32(`${coord.lat.toFixed(5)},${coord.lng.toFixed(5)}`);
  const rng = mulberry32(seed);
  const u = rng();
  const v = rng();

  // Uniform over the annulus AREA (not biased toward the inner radius).
  const dist = Math.sqrt(u * (maxMeters ** 2 - minMeters ** 2) + minMeters ** 2);
  const theta = 2 * Math.PI * v;

  const dLat = (dist * Math.cos(theta)) / METERS_PER_DEGREE;
  const latRad = (coord.lat * Math.PI) / 180;
  const dLng = (dist * Math.sin(theta)) / (METERS_PER_DEGREE * Math.cos(latRad));

  const out: JitterableCoord = { lat: coord.lat + dLat, lng: coord.lng + dLng };
  if (coord.label !== undefined) out.label = coord.label;
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/jitter.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/geocoding/jitter.ts apps/api/src/services/geocoding/__tests__/jitter.test.ts
git commit -m "feat(api): deterministic geo-jitter for PII locations (#243)"
```

---

### Task 3: Geocode path returns the exact point

Deletes the city-centroid step so geocoding always yields the true coordinate; the storage layer (Task 4) applies the jitter.

**Files:**
- Modify: `apps/api/src/services/geocoding/geo_resolver.ts` (delete `resolveCityCenter`, `resolveDetailed`, `parseGoogleGeocodeDetailed`, `parsePhotonFeaturesDetailed`, `GeoDetail`, `roundCoord`, `PhotonProps`)
- Modify: `apps/api/src/services/geocoding/resolve_locations_for_create.ts` (remove the private branch)
- Test: `apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts` (remove tests for deleted parsers)

**Interfaces:**
- Consumes: `resolveCoordinates(query: string): Promise<{ lat: number; lng: number } | null>` (unchanged, kept).
- Produces: `geocodeLocationsFromState(itemSchema, item_state, log?)` now returns **exact** coords for both private and public primary fields.

- [ ] **Step 1: Update the geocode-from-state test to expect an exact point for a private field**

In `apps/api/src/services/geocoding/__tests__/` add a focused test file `resolve_locations_for_create.test.ts` (create):

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveCoordinates = vi.fn();
vi.mock('../geo_resolver', () => ({ resolveCoordinates: (q: string) => resolveCoordinates(q) }));

import { geocodeLocationsFromState } from '../resolve_locations_for_create';

const privateSchema = {
  properties: { address: { type: 'string', location: 'primary', private: true } },
};

describe('geocodeLocationsFromState — private field', () => {
  beforeEach(() => resolveCoordinates.mockReset());

  it('returns the exact geocoded point (no city centroid)', async () => {
    resolveCoordinates.mockResolvedValue({ lat: 12.9716, lng: 77.5946 });
    const out = await geocodeLocationsFromState(privateSchema, { address: '12 MG Road, Bengaluru' });
    expect(out).toEqual([{ lat: 12.9716, lng: 77.5946 }]);
    expect(resolveCoordinates).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/resolve_locations_for_create.test.ts`
Expected: FAIL — current code calls `resolveCityCenter` (which the mock doesn't provide) for the private branch.

- [ ] **Step 3: Remove the private branch in `resolve_locations_for_create.ts`**

Replace the import at line 8 and the body of `geocodeLocationsFromState` (lines 28-55). The imports at the top (lines 1-8) become:

```typescript
import {
  getDomainItemSchema,
  parseLocationFields,
  buildLocationQueries,
} from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import { resolveCoordinates } from './geo_resolver';
```

And `geocodeLocationsFromState`:

```typescript
export async function geocodeLocationsFromState(
  itemSchema: Record<string, unknown>,
  item_state: Record<string, unknown>,
  log?: { warn: (obj: unknown, msg: string) => void },
): Promise<ItemLocation[]> {
  try {
    const { primary } = parseLocationFields(itemSchema);
    // Always resolve to the EXACT point. Privacy for a PRIVATE field is applied
    // downstream as a jitter at the storage choke point (item_service), so the
    // exact coordinate is never persisted.
    const queries = buildLocationQueries(item_state, primary);
    const out: ItemLocation[] = [];
    for (const { query, label } of queries) {
      const coord = await resolveCoordinates(query);
      if (coord) out.push(label ? { ...coord, label } : coord);
    }
    return out;
  } catch (err) {
    log?.warn({ err }, 'geocoding failed');
    return [];
  }
}
```

Also remove the now-unused `isLocationFieldPrivate` from the doc comment block of `resolveLocationsForCreate` if it references the private→city rule (update the comment lines 62-68 to say "Private and public primary fields both geocode to their exact point; a private field is jittered at storage time.").

- [ ] **Step 4: Delete the city-centroid code from `geo_resolver.ts`**

Delete these exports/helpers entirely: `GeoDetail` (interface, ~line 37-42), `parseGoogleGeocodeDetailed` (~44-69), `PhotonProps` (~71-77), `parsePhotonFeaturesDetailed` (~79-99), `resolveDetailed` (~117-130), `roundCoord` (~132-135), and `resolveCityCenter` (~155-182). Keep `Coordinates`, `parsePhotonFeatures`, `parseGoogleGeocode`, `resolveWithGoogle`, `resolveWithPhoton`, and `resolveCoordinates`.

- [ ] **Step 5: Remove the deleted-parser tests from `geo_resolver.test.ts`**

In `apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts`, delete the `parseGoogleGeocodeDetailed` and `parsePhotonFeaturesDetailed` imports and their `describe` blocks. Keep the `parsePhotonFeatures` and `parseGoogleGeocode` blocks.

- [ ] **Step 6: Run tests + typecheck**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/`
Expected: PASS (jitter + resolve_locations_for_create + trimmed geo_resolver).
Run: `pnpm typecheck`
Expected: PASS — verifies nothing else imported the deleted symbols.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/services/geocoding/
git commit -m "refactor(api): geocode private locations to exact point, drop city-centroid (#243)"
```

---

### Task 4: Jitter at the storage choke point

Replaces the 2-decimal rounding with the deterministic jitter for private fields.

**Files:**
- Modify: `apps/api/src/services/item_service.ts:34-82` (`PRIVATE_LOCATION_DECIMALS`, `roundTo`, `coarsenPrivateLocations`, `locationsForStorage`; add imports)
- Rename/replace test: `apps/api/src/services/__tests__/coarsen_private_locations.test.ts` → `jitter_private_locations.test.ts`

**Interfaces:**
- Consumes: `jitterCoordinate` (Task 2), `geocodingConfig.jitter_min_meters` / `jitter_max_meters` (Task 1).
- Produces: `jitterPrivateLocations(locations: ItemLocation[], itemSchema): ItemLocation[]` — private primary field → each location jittered; public/absent → unchanged. Used by `locationsForStorage` (create + update, Task 5).

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/__tests__/jitter_private_locations.test.ts` (delete the old `coarsen_private_locations.test.ts`):

```typescript
import { describe, it, expect } from 'vitest';
import { jitterPrivateLocations } from '../item_service';
import { jitterCoordinate } from '../geocoding/jitter';
import { geocodingConfig } from '@/config';

const privateSingle = {
  properties: { address: { type: 'string', location: 'primary', private: true } },
};
const publicSingle = {
  properties: { area: { type: 'string', location: 'primary' } },
};
const min = geocodingConfig.jitter_min_meters;
const max = geocodingConfig.jitter_max_meters;

describe('jitterPrivateLocations', () => {
  it('jitters a private primary location (matches jitterCoordinate)', () => {
    const locs = [{ lat: 12.9716, lng: 77.5946 }];
    expect(jitterPrivateLocations(locs, privateSingle)).toEqual([
      jitterCoordinate(locs[0], min, max),
    ]);
  });

  it('leaves a public location unchanged', () => {
    const locs = [{ lat: 12.9716, lng: 77.5946 }];
    expect(jitterPrivateLocations(locs, publicSingle)).toEqual(locs);
  });

  it('preserves label while jittering', () => {
    const locs = [{ lat: 12.9716, lng: 77.5946, label: 'Home' }];
    expect(jitterPrivateLocations(locs, privateSingle)[0].label).toBe('Home');
  });

  it('is a no-op for empty / no-schema / no-primary', () => {
    const locs = [{ lat: 1, lng: 2 }];
    expect(jitterPrivateLocations([], privateSingle)).toEqual([]);
    expect(jitterPrivateLocations(locs, { properties: {} })).toEqual(locs);
    expect(jitterPrivateLocations(locs, null)).toEqual(locs);
    expect(jitterPrivateLocations(locs, undefined)).toEqual(locs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/jitter_private_locations.test.ts`
Expected: FAIL — `jitterPrivateLocations` not exported.

- [ ] **Step 3: Replace the coarsening with the jitter**

In `apps/api/src/services/item_service.ts`:

Add imports near the existing `@/config` import (line 27) and geocoding import (line 22):

```typescript
import { jitterCoordinate } from '@/services/geocoding/jitter';
import { apiConfig, getCurrentApiBaseUrl, geocodingConfig } from '@/config';
```

Replace lines 34-64 (`PRIVATE_LOCATION_DECIMALS`, `roundTo`, `coarsenPrivateLocations`) with:

```typescript
/**
 * Jitters the coordinates of a PRIVATE (PII) primary location field so the exact
 * address is never persisted: each point is offset to a deterministic random
 * spot within the configured 100–250 m annulus (see geocoding/jitter.ts). This
 * is the authoritative server-side transform — even an API caller that submits
 * an exact coordinate for a private field has it jittered here before storage.
 * Non-private location fields are returned unchanged.
 */
export function jitterPrivateLocations(
  locations: ItemLocation[],
  itemSchema: Record<string, unknown> | null | undefined,
): ItemLocation[] {
  if (locations.length === 0 || !itemSchema || !isLocationFieldPrivate(itemSchema)) {
    return locations;
  }
  return locations.map((loc) =>
    jitterCoordinate(loc, geocodingConfig.jitter_min_meters, geocodingConfig.jitter_max_meters),
  );
}
```

Update `locationsForStorage` (was lines 74-82) to call the new function and refresh its doc comment:

```typescript
/**
 * Decides the coordinates to store for an item. NEVER geocodes — that happens in
 * the create/update paths. Here we apply the PII transform: a PRIVATE location
 * field's supplied coordinate is jittered (100–250 m) so an exact point can
 * never be persisted. Non-private fields are stored exactly as supplied.
 */
function locationsForStorage(
  provided: ItemLocation[],
  itemSchema: Record<string, unknown> | null | undefined,
): ItemLocation[] {
  return jitterPrivateLocations(provided, itemSchema);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/__tests__/jitter_private_locations.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git rm apps/api/src/services/__tests__/coarsen_private_locations.test.ts
git add apps/api/src/services/item_service.ts apps/api/src/services/__tests__/jitter_private_locations.test.ts
git commit -m "feat(api): jitter PII locations at storage instead of rounding (#243)"
```

---

### Task 5: Update-path drift guard

Skip re-jittering when the caller echoes back the already-stored (jittered) coordinates.

**Files:**
- Modify: `apps/api/src/services/item_service.ts` — add `sameLocations` helper; add `item_locations` to the `existingItem` select (line 305-314); guard the provided-coords branch (line 418-426)
- Test: `apps/api/src/services/__tests__/same_locations.test.ts` (create)

**Interfaces:**
- Produces: `sameLocations(a: ItemLocation[], b: ItemLocation[]): boolean` — order-sensitive coordinate + label equality.

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/__tests__/same_locations.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { sameLocations } from '../item_service';

describe('sameLocations', () => {
  it('true for identical coord arrays', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [{ lat: 1, lng: 2 }])).toBe(true);
  });
  it('true when labels match', () => {
    expect(
      sameLocations([{ lat: 1, lng: 2, label: 'x' }], [{ lat: 1, lng: 2, label: 'x' }]),
    ).toBe(true);
  });
  it('false on differing coord', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [{ lat: 1, lng: 3 }])).toBe(false);
  });
  it('false on differing length', () => {
    expect(sameLocations([{ lat: 1, lng: 2 }], [])).toBe(false);
  });
  it('false on differing label', () => {
    expect(
      sameLocations([{ lat: 1, lng: 2, label: 'x' }], [{ lat: 1, lng: 2, label: 'y' }]),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/__tests__/same_locations.test.ts`
Expected: FAIL — `sameLocations` not exported.

- [ ] **Step 3: Add the helper**

In `apps/api/src/services/item_service.ts`, add near `primaryLocation` (after line 32):

```typescript
/**
 * Order-sensitive equality of two location arrays (coords + label). Used by the
 * update path to detect a caller echoing back the already-stored (jittered)
 * coordinates, so we leave them as-is instead of jittering a jittered point.
 */
export function sameLocations(a: ItemLocation[], b: ItemLocation[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (l, i) =>
      l.lat === b[i].lat && l.lng === b[i].lng && (l.label ?? undefined) === (b[i].label ?? undefined),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/__tests__/same_locations.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Select the stored `item_locations` in the update path**

In `apps/api/src/services/item_service.ts`, add to the `existingItem` select (after line 313, `lifecycle_status`):

```typescript
        item_locations: items.item_locations,
```

- [ ] **Step 6: Guard the provided-coords branch**

Replace the `if (providedCoords) { ... }` block (lines 422-426):

```typescript
    if (providedCoords) {
      const stored = (existingItem.item_locations ?? []) as ItemLocation[];
      // Caller echoed back the already-stored (jittered) coords → leave as-is,
      // so a read-modify-write update never re-jitters a jittered point.
      updateValues.item_locations = sameLocations(providedCoords, stored)
        ? stored
        : locationsForStorage(providedCoords, itemSchema as Record<string, unknown>);
    } else if (addressChanged) {
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/services/item_service.ts apps/api/src/services/__tests__/same_locations.test.ts
git commit -m "feat(api): skip re-jitter when update echoes stored coords (#243)"
```

---

### Task 6: Browser sends the exact coordinate for private fields

Removes the duplicated client-side city coarsening; the server is now authoritative.

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx:364-414` (`coarsenPlace` + its callers)

**Interfaces:**
- Consumes: nothing new. `getGeoProvider`, `parseLocationFields`, `buildLocationQueries` unchanged.

- [ ] **Step 1: Replace `coarsenPlace` with a pass-through and simplify the comment**

In `apps/ui/src/pages/profile-form-page.tsx`, replace the `coarsenPlace` definition and its surrounding comment (lines 364-396). The block from the comment `// Resolve the coordinates to store...` down to the end of `coarsenPlace` becomes:

```typescript
      // Resolve the coordinates to submit, client-side, using the same (Google)
      // geocoder the autocomplete uses. We send the EXACT point for every field —
      // for a PRIVATE field the server jitters it (100–250 m) before storing, so
      // the exact coordinate is never persisted (see PII location jitter, #243).
      // Resolve from the picked suggestion(s) when available, else the typed text.
      const toPoint = (
        lat: number,
        lng: number,
        label: string | undefined,
      ): { lat: number; lng: number; label?: string } => (label ? { lat, lng, label } : { lat, lng });
```

- [ ] **Step 2: Update the two call sites to use `toPoint`**

Replace the `item_locations.push(await coarsenPlace(...))` calls (lines 403 and 412). The `resolvedLocations` loop (line 400-404):

```typescript
      if (resolvedLocations.length > 0) {
        // A suggestion was picked in the widget.
        for (const place of resolvedLocations) {
          item_locations.push(toPoint(place.lat, place.lng, place.label));
        }
      } else if (profileSchema) {
        // No suggestion picked — geocode the marked field(s) from the typed text.
        const { primary } = parseLocationFields(profileSchema as Record<string, unknown>);
        const queries = buildLocationQueries(data, primary);
        for (const { query, label } of queries) {
          const [best] = await getGeoProvider().suggest(query);
          if (best) item_locations.push(toPoint(best.lat, best.lng, label));
        }
      }
```

Note: `isPrivateLocationField` / `isLocationFieldPrivate` and `GeoComponents` may now be unused in this file — remove the now-dead `const isPrivateLocationField = ...` (lines 371-373) and drop unused imports (`isLocationFieldPrivate` from line 35, `GeoComponents` type from line 37) if the typecheck flags them.

- [ ] **Step 3: Typecheck (ui)**

Run: `pnpm typecheck`
Expected: PASS. Fix any unused-import errors surfaced from Step 2.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/pages/profile-form-page.tsx
git commit -m "feat(ui): send exact coord for private locations; server jitters (#243)"
```

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full api unit suite**

Run: `pnpm --filter api test`
Expected: PASS. Investigate any create/update test that asserted the old city-centroid or 2-decimal rounding and update it to expect a jittered point (distance in [min,max] from the input, deterministic).

- [ ] **Step 2: Run config tests**

Run: `pnpm --filter @dpg/config test`
Expected: PASS.

- [ ] **Step 3: Typecheck everything**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Grep for stragglers**

Run: `grep -rn "resolveCityCenter\|coarsenPrivateLocations\|coarsenPlace\|PRIVATE_LOCATION_DECIMALS" apps packages --include="*.ts" --include="*.tsx" | grep -v node_modules`
Expected: no matches.

- [ ] **Step 5: Commit any test fixups**

```bash
git add -A
git commit -m "test(api): update location tests for PII jitter (#243)"
```
