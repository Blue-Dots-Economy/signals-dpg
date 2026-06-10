# Multi-location Items Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store multiple coordinates per item in a single `item_locations` jsonb array (replacing the scalar `item_latitude/longitude`), so a provider appears on the map at every served city (not their private address), is found by radius search at any of them, with PII-aware coarsening for private location fields.

**Architecture:** Config-driven via the `location` marker (`@dpg/schemas`), one axis — cardinality: `"location": "single"` = one coord; `"location": "multiple"` = an array field (e.g. `service_cities`) → one coord per entry. Autocomplete is unrestricted (city or address). The scalar columns become one `item_locations jsonb` array everywhere (items + action_events + API shape); a read-time `primaryLocation()=[0]` covers single-point needs. PII fields (`private:true`) store a coarse city/area coord. Match-score keeps receiving a derived scalar `number` so the external scorer is unchanged.

**Tech Stack:** TypeScript (ESM, strict), Drizzle + Postgres (partitioned `items`, `earthdistance`/`cube`), Zod (+ drizzle-zod), Fastify, React 19 + RJSF, Vitest (packages/schemas + apps/api). UI has no test runner — verify UI via `tsc`.

**Spec:** `docs/superpowers/specs/2026-06-08-multi-location-items-design.md`

**Branch:** `feat/multi-location-items` (already checked out).

---

## File structure (what changes)

**Shared logic** — `packages/schemas/src/location_fields.ts` (extend), its test.
**Data model** — `packages/database/src/drizzle_ref_tables/items.ts`, `.../action_events.ts`; raw SQL `packages/database/src/utils/sql_scripts/create_items.sql`, `create_actions_events.sql`; deploy bundle `apps/api/db/postgres/schema.sql` (regenerated); a one-off backfill SQL.
**API schemas** — `packages/schemas/src/api/item_schemas.ts`, `action_schemas.ts`; UI clients `apps/ui/src/lib/item-api.ts`, `action-api.ts`, `match-score-api.ts`; `packages/match_score/src/match_score.types.ts`.
**API logic** — `apps/api/src/services/item_service.ts`, `routes/v1/item/create_item.ts`, `routes/v1/item/geotag_item.ts`, `utils/item_fetch_runtime.ts`, `utils/inter_instance_fetch.ts`, `routes/v1/network/item/fetch_item.ts`, `lib/profile_item.ts`, `utils/action_event_runtime.ts`, `routes/v1/action/update_action_status.ts`, `routes/v1/network/action/perform_action.ts`.
**UI** — `apps/ui/src/lib/geo/{types,provider,photon,google-places}.ts`, `components/forms/custom-widgets/{location-autocomplete-widget,multi-location-autocomplete-widget}.tsx`, `components/forms/schema-form.tsx`, `pages/profile-form-page.tsx`, `components/map/map-container.tsx`, `pages/home-page.tsx`, `components/actions/action-card.tsx`.
**Config** — `examples/schemas/purple_dot/network.json`, `apps/ui/src/theme/form-layouts.ts`.

**Conventions:** node 24 (`source ~/.nvm/nvm.sh && nvm use 24`); schemas tests `pnpm --filter schemas test`; api tests `pnpm --filter api test`; ui typecheck `pnpm --filter ui exec tsc --noEmit`; after edits run codacy if available. Commit after each task.

---

## Phase 1 — Shared marker logic

### Task 1: Extend `@dpg/schemas` with `multi` + `buildLocationQueries`

**Files:**
- Modify: `packages/schemas/src/location_fields.ts`
- Test: `packages/schemas/src/__tests__/location_fields.test.ts`

- [ ] **Step 1: Add the failing tests** (append to the existing test file)

```ts
import { parseLocationFields, buildLocationQueries } from '../location_fields';

const singleSchema = { properties: { address: { type: 'string', location: 'single' } } };
const multipleSchema = { properties: { service_cities: { type: 'array', location: 'multiple' } } };

describe('parseLocationFields', () => {
  it('captures a single field', () => {
    expect(parseLocationFields(singleSchema)).toEqual({ field: 'address', cardinality: 'single' });
  });
  it('captures a multiple field', () => {
    expect(parseLocationFields(multipleSchema)).toEqual({ field: 'service_cities', cardinality: 'multiple' });
  });
  it('null when no marker', () => {
    expect(parseLocationFields({ properties: { x: { type: 'string' } } })).toEqual({ field: null, cardinality: null });
  });
});

describe('buildLocationQueries', () => {
  it('multiple → one query+label per non-empty array entry', () => {
    expect(buildLocationQueries({ service_cities: ['Goa', '', 'Hubli'] }, parseLocationFields(multipleSchema)))
      .toEqual([{ query: 'Goa', label: 'Goa' }, { query: 'Hubli', label: 'Hubli' }]);
  });
  it('single → one query, no label', () => {
    expect(buildLocationQueries({ address: 'MG Rd, Bengaluru' }, parseLocationFields(singleSchema)))
      .toEqual([{ query: 'MG Rd, Bengaluru' }]);
  });
  it('returns [] when nothing usable', () => {
    expect(buildLocationQueries({}, parseLocationFields(singleSchema))).toEqual([]);
    expect(buildLocationQueries({ service_cities: [] }, parseLocationFields(multipleSchema))).toEqual([]);
  });
});
```

- [ ] **Step 2: Run → fail.** `pnpm --filter schemas exec vitest run src/__tests__/location_fields.test.ts` → FAIL (`buildLocationQueries` undefined, `multi` missing).

- [ ] **Step 3: Implement** — replace `location_fields.ts` with:

```ts
/**
 * Marker-driven location-field selection. Exactly ONE field per domain is the
 * geo field, marked:
 *   - "location": "single"   — a string field → one coordinate.
 *   - "location": "multiple" — an array-of-strings field → one coordinate per entry.
 * No granularity/level axis (autocomplete is unrestricted) and no secondary fields.
 * Shared by UI (form + map) and API (server-side geocode).
 */
export type LocationCardinality = 'single' | 'multiple';
export interface LocationFields {
  field: string | null;
  cardinality: LocationCardinality | null;
}

/** One coordinate. `label` is the place/city name when known. */
export interface LocationPoint {
  lat: number;
  lng: number;
  label?: string;
}

type JsonSchemaProperty = { location?: unknown };

export function parseLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationFields {
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  for (const [name, prop] of Object.entries(properties)) {
    if (prop?.location === 'single') return { field: name, cardinality: 'single' };
    if (prop?.location === 'multiple') return { field: name, cardinality: 'multiple' };
  }
  return { field: null, cardinality: null };
}

/**
 * The geocode queries that produce the item's locations:
 *   - multiple → one {query,label} per non-empty array entry (label = the value).
 *   - single   → one {query} from the field's string value.
 *   - else     → [].
 * Pure; the caller geocodes each query.
 */
export function buildLocationQueries(
  data: Record<string, unknown>,
  fields: LocationFields
): Array<{ query: string; label?: string }> {
  if (!fields.field) return [];
  const raw = data[fields.field];
  if (fields.cardinality === 'multiple') {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => ({ query: v.trim(), label: v.trim() }));
  }
  return typeof raw === 'string' && raw.trim() ? [{ query: raw.trim() }] : [];
}
```

- [ ] **Step 4: Run → pass.** Same command → all green. Then `pnpm --filter schemas test` → update any existing geotagging test that asserted the old `{primary, secondary}` shape to the new `{field, cardinality}` shape.

- [ ] **Step 5: Re-export** — `buildGeoQuery` is removed (no composite/secondary). Update `packages/schemas/src/index.ts` to `export { parseLocationFields, buildLocationQueries, type LocationFields, type LocationPoint } from './location_fields'` (drop `buildGeoQuery`; its callers — map-container, profile-form, geotag — migrate to `buildLocationQueries` in later tasks).

- [ ] **Step 6: Codacy (if available), then commit.**
```bash
git add packages/schemas/src/location_fields.ts packages/schemas/src/__tests__/location_fields.test.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): location multi marker + buildLocationQueries"
```

---

## Phase 2 — Data model + migration

### Task 2: Drizzle tables — scalar coords → `item_locations` jsonb

**Files:**
- Modify: `packages/database/src/drizzle_ref_tables/items.ts`
- Modify: `packages/database/src/drizzle_ref_tables/action_events.ts`

- [ ] **Step 1: `items.ts`** — replace lines 29-30 (`item_latitude`/`item_longitude` doublePrecision) with a typed jsonb array; drop the now-unused `doublePrecision` import:
```ts
// remove: import { doublePrecision, ... }
// in the column block, replace item_latitude/item_longitude with:
    item_locations: jsonb('item_locations')
      .$type<Array<{ lat: number; lng: number; label?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
```

- [ ] **Step 2: `action_events.ts`** — replace the four scalar columns (`source_item_latitude/longitude`, `target_item_latitude/longitude`) with two jsonb arrays:
```ts
    source_item_locations: jsonb('source_item_locations')
      .$type<Array<{ lat: number; lng: number; label?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    target_item_locations: jsonb('target_item_locations')
      .$type<Array<{ lat: number; lng: number; label?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
```
Add `jsonb` + `sql` imports if missing; remove `doublePrecision` if now unused.

- [ ] **Step 3: Typecheck the package.** `pnpm --filter @dpg/database exec tsc --noEmit` (or `pnpm typecheck` once API compiles after Task 4 — expect API/UI errors until later tasks; at this step only confirm the database package itself compiles).

- [ ] **Step 4: Commit.**
```bash
git add packages/database/src/drizzle_ref_tables/items.ts packages/database/src/drizzle_ref_tables/action_events.ts
git commit -m "feat(db): items/action_events store item_locations jsonb arrays"
```

### Task 3: Raw SQL bootstrap + backfill + bundle

**Files:**
- Modify: `packages/database/src/utils/sql_scripts/create_items.sql`
- Modify: `packages/database/src/utils/sql_scripts/create_actions_events.sql`
- Create: `packages/database/src/utils/sql_scripts/migrate_item_locations.sql`
- Modify (regenerated): `apps/api/db/postgres/schema.sql`

> These index/constraint/column changes are NOT produced by `pnpm db:generate:api` (the GiST index + CHECK constraints live only in raw SQL). They are authored by hand here.

- [ ] **Step 1: `create_items.sql`** — for a FRESH db (`pnpm db:init:api`): replace the two `item_latitude/longitude DOUBLE PRECISION` columns with `item_locations JSONB NOT NULL DEFAULT '[]'::jsonb`; **delete** the lat/lng CHECK constraints (the three around lines 27-37) and the `items_geo_earth_idx` GiST index (lines 56-57). Keep `CREATE EXTENSION earthdistance/cube` (still used by the geosearch on jsonb elements).

- [ ] **Step 2: `create_actions_events.sql`** — replace the four scalar source/target lat/lng columns with `source_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb` and `target_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb`.

- [ ] **Step 3: backfill migration** — create `migrate_item_locations.sql` for an EXISTING db:
```sql
-- items: add jsonb, backfill from scalars, drop scalars + index + checks
ALTER TABLE items ADD COLUMN IF NOT EXISTS item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE items SET item_locations = jsonb_build_array(jsonb_build_object('lat', item_latitude, 'lng', item_longitude))
  WHERE item_latitude IS NOT NULL AND item_longitude IS NOT NULL AND item_locations = '[]'::jsonb;
DROP INDEX IF EXISTS items_geo_earth_idx;
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_latitude_check;
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_longitude_check;
ALTER TABLE items DROP CONSTRAINT IF EXISTS items_lat_lng_pair_check;  -- use the actual constraint names from create_items.sql
ALTER TABLE items DROP COLUMN IF EXISTS item_latitude;
ALTER TABLE items DROP COLUMN IF EXISTS item_longitude;
-- action_events: same shape
ALTER TABLE action_events ADD COLUMN IF NOT EXISTS source_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE action_events ADD COLUMN IF NOT EXISTS target_item_locations JSONB NOT NULL DEFAULT '[]'::jsonb;
UPDATE action_events SET source_item_locations = jsonb_build_array(jsonb_build_object('lat', source_item_latitude, 'lng', source_item_longitude))
  WHERE source_item_latitude IS NOT NULL AND source_item_longitude IS NOT NULL AND source_item_locations = '[]'::jsonb;
UPDATE action_events SET target_item_locations = jsonb_build_array(jsonb_build_object('lat', target_item_latitude, 'lng', target_item_longitude))
  WHERE target_item_latitude IS NOT NULL AND target_item_longitude IS NOT NULL AND target_item_locations = '[]'::jsonb;
ALTER TABLE action_events DROP COLUMN IF EXISTS source_item_latitude;
ALTER TABLE action_events DROP COLUMN IF EXISTS source_item_longitude;
ALTER TABLE action_events DROP COLUMN IF EXISTS target_item_latitude;
ALTER TABLE action_events DROP COLUMN IF EXISTS target_item_longitude;
```
First, read `create_items.sql` to use the **actual** CHECK constraint names. Apply it to the running dev DB:
```bash
docker exec -i dpg-db psql -U postgres -d postgresdb < packages/database/src/utils/sql_scripts/migrate_item_locations.sql
```

- [ ] **Step 4: regenerate the deploy bundle + verify.**
```bash
pnpm schema:bundle && pnpm schema:bundle:check
```
Expected: PASS (bundle now reflects `item_locations`, no scalar coords / GiST index / lat-lng checks).

- [ ] **Step 5: Commit.**
```bash
git add packages/database/src/utils/sql_scripts/create_items.sql packages/database/src/utils/sql_scripts/create_actions_events.sql packages/database/src/utils/sql_scripts/migrate_item_locations.sql apps/api/db/postgres/schema.sql
git commit -m "feat(db): raw SQL + backfill migration for item_locations; drop scalar coords/index/checks"
```

### Task 4: Zod schemas — `item_locations` validation + keep geo-search inputs

**Files:**
- Modify: `packages/schemas/src/api/item_schemas.ts`
- Modify: `packages/schemas/src/api/action_schemas.ts`

- [ ] **Step 1: `item_schemas.ts`** — after the drizzle-zod derivations, override `item_locations` with a validated array on each shape. Add a shared point schema and extend:
```ts
const ItemLocationPoint = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  label: z.string().optional(),
});
const ItemLocationsArray = z.array(ItemLocationPoint);

// drizzle-zod gives item_locations a loose type from the jsonb column; tighten it:
export const ItemResponseSchema = ItemSelectSchema.omit({ item_private_state: true })
  .extend({ item_locations: ItemLocationsArray });
export const CreateItemBodySchema = ItemInsertSchema.omit({ /* …unchanged omits… */ })
  .extend({ created_by: z.string().min(1).optional(), item_locations: ItemLocationsArray.optional() });
export const UpdateItemBodySchema = /* …unchanged omits…*/.partial().strict()
  .extend({ item_locations: ItemLocationsArray.optional() })
  .refine((d) => Object.keys(d).length > 0, { message: 'At least one field must be provided for update' });
export const ItemSnapshotSchema = ItemResponseSchema.omit({ created_by: true, created_at: true, updated_at: true });
```
**Keep `FetchItemsSchemaBase` unchanged** — `item_latitude` / `item_longitude` / `radius_meters` stay as geo-search *input* params (the EXISTS clause needs them). Do NOT remove them.

- [ ] **Step 2: `action_schemas.ts`** — in `StoreEventBodySchema` (lines ~67-70) replace the four scalar `source_/target_item_latitude/longitude` fields with:
```ts
  source_item_locations: ItemLocationsArray.optional(),
  target_item_locations: ItemLocationsArray.optional(),
```
(import/share `ItemLocationsArray` — re-export it from `item_schemas.ts` or duplicate the small schema).

- [ ] **Step 3: Run the schemas suite.** `pnpm --filter schemas test` → green (update any schema test asserting the scalar fields).

- [ ] **Step 4: Commit.**
```bash
git add packages/schemas/src/api/item_schemas.ts packages/schemas/src/api/action_schemas.ts
git commit -m "feat(schemas): item_locations array validation; keep geo-search input params"
```

---

## Phase 3 — API logic

### Task 5: `item_service` — persist `item_locations` + `primaryLocation`

**Files:**
- Modify: `apps/api/src/services/item_service.ts`
- Test: `apps/api/src/services/__tests__/primary_location.test.ts` (create)

- [ ] **Step 1: failing test for the helper.**
```ts
import { describe, it, expect } from 'vitest';
import { primaryLocation } from '../item_service';
describe('primaryLocation', () => {
  it('returns first entry', () => {
    expect(primaryLocation([{ lat: 1, lng: 2, label: 'A' }, { lat: 3, lng: 4 }])).toEqual({ lat: 1, lng: 2, label: 'A' });
  });
  it('returns null for empty', () => {
    expect(primaryLocation([])).toBeNull();
    expect(primaryLocation(undefined)).toBeNull();
  });
});
```
Run → fail.

- [ ] **Step 2: implement + wire.** In `item_service.ts`:
  - Export helper:
  ```ts
  export type ItemLocation = { lat: number; lng: number; label?: string };
  export function primaryLocation(locs: ItemLocation[] | null | undefined): ItemLocation | null {
    return locs && locs.length > 0 ? locs[0] : null;
  }
  ```
  - In `CreateItemServiceParams` / `UpdateItemServiceBody`: replace `item_latitude?/item_longitude?` with `item_locations?: ItemLocation[]`.
  - In `createItemInternal` insert (lines ~167-168): replace `item_latitude/item_longitude` with `item_locations: params.item_locations ?? []`.
  - In `updateItemInternal` (lines ~210-211): replace the scalar set with `if (body.item_locations !== undefined) updateValues.item_locations = body.item_locations;`.
  - In the select column lists (`itemResponseColumns` etc., lines ~41-49, 293-294): replace `item_latitude/item_longitude` with `item_locations: items.item_locations`.

- [ ] **Step 3: Run → pass.** `pnpm --filter api exec vitest run src/services/__tests__/primary_location.test.ts`.

- [ ] **Step 4: Commit.**
```bash
git add apps/api/src/services/item_service.ts apps/api/src/services/__tests__/primary_location.test.ts
git commit -m "feat(api): item_service persists item_locations; primaryLocation helper"
```

### Task 6: Create-item geocoding → `item_locations` (multi/primary)

**Files:**
- Modify: `apps/api/src/routes/v1/item/geotag_item.ts`
- Modify: `apps/api/src/routes/v1/item/create_item.ts`
- Test: `apps/api/src/routes/v1/item/__tests__/create_item.test.ts`

- [ ] **Step 1: failing test** — rewrite `resolveItemCoordinates` → `resolveItemLocations`:
```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveItemLocations } from '../geotag_item';

const multiSchema = { properties: { service_cities: { type: 'array', location: 'multiple' } } };
const primarySchema = { properties: { address: { type: 'string', location: 'single' } } };

describe('resolveItemLocations', () => {
  it('passes provided locations through unchanged', async () => {
    const out = await resolveItemLocations({ provided: [{ lat: 1, lng: 2 }], itemState: {}, itemSchema: multiSchema, geocode: vi.fn() });
    expect(out).toEqual([{ lat: 1, lng: 2 }]);
  });
  it('multi → geocodes each city, attaches label, skips failures', async () => {
    const geocode = vi.fn(async (q: string) => (q === 'Goa' ? { lat: 15, lng: 73 } : null));
    const out = await resolveItemLocations({ provided: undefined, itemState: { service_cities: ['Goa', 'Nowhere'] }, itemSchema: multiSchema, geocode });
    expect(out).toEqual([{ lat: 15, lng: 73, label: 'Goa' }]);
  });
  it('primary → one geocoded coord', async () => {
    const geocode = vi.fn(async () => ({ lat: 12, lng: 77 }));
    const out = await resolveItemLocations({ provided: undefined, itemState: { address: 'X' }, itemSchema: primarySchema, geocode });
    expect(out).toEqual([{ lat: 12, lng: 77 }]);
  });
  it('returns [] when no marker/value', async () => {
    expect(await resolveItemLocations({ provided: undefined, itemState: {}, itemSchema: { properties: {} }, geocode: vi.fn() })).toEqual([]);
  });
});
```
Run → fail.

- [ ] **Step 2: implement `geotag_item.ts`.**
```ts
import { parseLocationFields, buildLocationQueries } from '@dpg/schemas';

interface ResolveArgs {
  provided: Array<{ lat: number; lng: number; label?: string }> | undefined;
  itemState: Record<string, unknown>;
  itemSchema: Record<string, unknown>;
  geocode: (query: string) => Promise<{ lat: number; lng: number } | null>;
}

/**
 * Resolves an item's locations: the caller-supplied array when present, else one
 * geocoded coord per marked query (multi → per city w/ label; primary → composite).
 * Best-effort — entries that fail to geocode are skipped.
 */
export async function resolveItemLocations(
  args: ResolveArgs
): Promise<Array<{ lat: number; lng: number; label?: string }>> {
  if (args.provided && args.provided.length > 0) return args.provided;
  const fields = parseLocationFields(args.itemSchema);
  const queries = buildLocationQueries(args.itemState, fields);
  const out: Array<{ lat: number; lng: number; label?: string }> = [];
  for (const { query, label } of queries) {
    const coord = await args.geocode(query);
    if (coord) out.push(label ? { ...coord, label } : coord);
  }
  return out;
}
```

- [ ] **Step 3: wire into `create_item.ts`.** Replace the lat/lng block (the `let lat/lng` + `if (lat===null||lng===null)` geocode block) with:
```ts
let item_locations = body.item_locations ?? [];
if (item_locations.length === 0) {
  try {
    const networkConfig = await getNetworkConfigById(body.item_network);
    const itemSchema = getDomainItemSchema(networkConfig, body.item_domain, body.item_type) as Record<string, unknown> | null;
    if (itemSchema) {
      item_locations = await resolveItemLocations({
        provided: undefined,
        itemState: body.item_state ?? {},
        itemSchema,
        geocode: resolveCoordinates,
      });
    }
  } catch (err) {
    request.log.warn({ err, item_network: body.item_network, item_domain: body.item_domain }, 'backend geocoding failed; creating item without coordinates');
  }
}
```
and pass `item_locations` (not lat/lng) to `createItemInternal`. Update the import to `resolveItemLocations`.

- [ ] **Step 4: Run → pass.** `pnpm --filter api exec vitest run src/routes/v1/item/__tests__/create_item.test.ts`.

- [ ] **Step 5: Commit.**
```bash
git add apps/api/src/routes/v1/item/geotag_item.ts apps/api/src/routes/v1/item/create_item.ts apps/api/src/routes/v1/item/__tests__/create_item.test.ts
git commit -m "feat(api): create-item resolves item_locations (multi/primary)"
```

### Task 7: Geo-search matches ANY location

**Files:**
- Modify: `apps/api/src/utils/item_fetch_runtime.ts`
- Test: `apps/api/src/utils/__tests__/item_fetch_geo.test.ts` (create — test the SQL fragment builder if extracted; otherwise cover via the integration test in Task 18)

- [ ] **Step 1:** In `buildWhereClause`, replace the two scalar `earth_box`/`earth_distance` conditions (lines ~81-97) with a single EXISTS over the array:
```ts
conditions.push(sql`
  EXISTS (
    SELECT 1 FROM jsonb_array_elements(${items.item_locations}) loc
    WHERE earth_box(ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}), ${filters.radius_meters})
            @> ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)
      AND earth_distance(ll_to_earth(${filters.item_latitude}, ${filters.item_longitude}),
            ll_to_earth((loc->>'lat')::float8, (loc->>'lng')::float8)) <= ${filters.radius_meters}
  )
`);
```
Update `ItemFetchFilters` to drop `item_latitude?/longitude?` as *stored* fields only if present as response columns; keep the **search-input** `item_latitude/item_longitude/radius_meters` filter fields. In `itemResponseColumns` (lines ~37-38) replace the scalar columns with `item_locations: items.item_locations`.

- [ ] **Step 2: Typecheck the API.** `pnpm --filter api exec tsc --noEmit` (expect remaining errors in not-yet-updated files; confirm this file compiles).

- [ ] **Step 3: Commit.**
```bash
git add apps/api/src/utils/item_fetch_runtime.ts
git commit -m "feat(api): radius geo-search matches any item_locations entry"
```

### Task 8: Carry `item_locations` through fetch/inter-instance/profile

**Files:**
- Modify: `apps/api/src/routes/v1/network/item/fetch_item.ts`
- Modify: `apps/api/src/utils/inter_instance_fetch.ts`
- Modify: `apps/api/src/lib/profile_item.ts`
- Modify: `apps/api/src/routes/v1/item/fetch_item.ts`

- [ ] **Step 1:** In each, replace references to `item_latitude`/`item_longitude` (selects, response mapping, snapshot shape) with `item_locations`. In `profile_item.ts` (lines ~45-46) where it passes `item_latitude/longitude: null` to `createItemInternal`, change to `item_locations: []`. `inter_instance_fetch.ts` (lines ~154-155) — it forwards the geosearch **input** `radius_meters`/center; keep those as inputs, and ensure the merged response carries `item_locations` (it stores whole items, so it does once the response column changes).

- [ ] **Step 2: Typecheck.** `pnpm --filter api exec tsc --noEmit` — fewer errors now.

- [ ] **Step 3: Commit.**
```bash
git add apps/api/src/routes/v1/network/item/fetch_item.ts apps/api/src/utils/inter_instance_fetch.ts apps/api/src/lib/profile_item.ts apps/api/src/routes/v1/item/fetch_item.ts
git commit -m "feat(api): thread item_locations through fetch/inter-instance/profile"
```

### Task 9: Action-event snapshots → location arrays

**Files:**
- Modify: `apps/api/src/utils/action_event_runtime.ts`
- Modify: `apps/api/src/routes/v1/action/update_action_status.ts`
- Modify: `apps/api/src/routes/v1/network/action/perform_action.ts`
- Modify: `packages/match_score/src/match_score.types.ts`
- Modify: `apps/ui/src/lib/action-api.ts`
- Modify: existing action tests asserting `*_item_latitude`

- [ ] **Step 1:** `action_event_runtime.ts` — the snapshot select (lines ~79-80, 100-104) selects `items.item_latitude/longitude`; change to `items.item_locations`. The event insert (lines ~140-141, 148-149) sets `source_/target_item_latitude/longitude`; change to `source_item_locations`/`target_item_locations` (the item's `item_locations`).
- [ ] **Step 2:** `update_action_status.ts` (lines ~250-253) + `perform_action.ts` (lines ~225-228) — update the snapshot field names to the arrays.
- [ ] **Step 3:** `match_score.types.ts` (lines ~9-10) `MatchScoreItem` — replace `item_latitude?/longitude?` with `item_latitude?: number | null; item_longitude?: number | null` **kept** (the scorer still wants a number — these are filled from `primaryLocation`). Add nothing else. (No array here — scorer unchanged.)
- [ ] **Step 4:** `action-api.ts` — replace `source_/target_item_latitude/longitude` types with `source_item_locations`/`target_item_locations: Array<{lat;lng;label?}>`.
- [ ] **Step 5:** Update the action unit tests that assert `*_item_latitude` to assert `*_item_locations`. Run `pnpm --filter api test` → green.
- [ ] **Step 6: Commit.**
```bash
git add apps/api/src/utils/action_event_runtime.ts apps/api/src/routes/v1/action/update_action_status.ts apps/api/src/routes/v1/network/action/perform_action.ts packages/match_score/src/match_score.types.ts apps/ui/src/lib/action-api.ts apps/api/src/routes/v1/action/__tests__
git commit -m "feat(api): action-event snapshots store item_locations arrays"
```

---

## Phase 4 — UI

### Task 10: Geo provider — `level` + address `components`

**Files:**
- Modify: `apps/ui/src/lib/geo/types.ts`, `provider.ts`, `photon.ts`, `google-places.ts`

- [ ] **Step 1: `types.ts`** — add `components` to `GeoSuggestion` (autocomplete stays unrestricted — **no level**; `suggest` signature unchanged):
```ts
export interface GeoComponents { locality?: string; city?: string; state?: string; postcode?: string; country?: string; }
export interface GeoSuggestion { label: string; lat: number; lng: number; components?: GeoComponents; }
export interface GeoProvider { suggest(query: string, signal?: AbortSignal): Promise<GeoSuggestion[]>; }
```
- [ ] **Step 2: `photon.ts`** — in `parsePhotonFeatures`, set `components: { locality: p.name, city: p.city, state: p.state, postcode: p.postcode, country: p.country }`. No `layer` filter (unrestricted — returns cities and addresses).
- [ ] **Step 3: `google-places.ts`** — `fetchFields(['location','addressComponents'])`; map addressComponents → `components` (sublocality/neighborhood → locality, locality → city, administrative_area_level_1 → state, postal_code, country). **No** `includedPrimaryTypes` (unrestricted — "Goa" returns "Goa, India" and full addresses both).
- [ ] **Step 4: `provider.ts`** — wrapper unchanged in shape (`suggest(query, signal)`), still PII-guarded.
- [ ] **Step 5: Typecheck UI.** `pnpm --filter ui exec tsc --noEmit` — geo files compile (signature unchanged, so existing call sites still work; `components` is additive).
- [ ] **Step 6: Commit.**
```bash
git add apps/ui/src/lib/geo/
git commit -m "feat(ui): geo provider suggestions carry address components"
```

### Task 11: Multi-city autocomplete widget

**Files:**
- Create: `apps/ui/src/components/forms/custom-widgets/multi-location-autocomplete-widget.tsx`

- [ ] **Step 1: implement** a widget bound to an array-of-strings field. It manages rows (each an **unrestricted** autocomplete — the user can type a city or an address), enforces `maxItems` from the field schema, writes `string[]` via `onChange`, and reports the coordinate set via `formContext.onLocationsResolved(Array<{lat,lng,label}>)`. Model it on the existing `location-autocomplete-widget.tsx` (debounced search, `onMouseDown` select, blur-close) but per-row, with an "Add city" button (disabled at `maxItems`) and per-row remove. Each selection → `{ lat, lng, label: <picked label> }`. The full set is reported on every add/remove/select. (Read `location-autocomplete-widget.tsx` for the row pattern; reuse `getGeoProvider`, `GeoSuggestion`.)

- [ ] **Step 2: Typecheck UI** → the widget compiles (calls `suggest(q, signal)`).
- [ ] **Step 3: Commit.**
```bash
git add apps/ui/src/components/forms/custom-widgets/multi-location-autocomplete-widget.tsx
git commit -m "feat(ui): multi-city autocomplete widget for location:multi fields"
```

### Task 12: Single widget — PII coarsening + components + level

**Files:**
- Modify: `apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx`

- [ ] **Step 1:** `suggest` calls stay `suggest(q, signal)` (unrestricted). On select, branch on the field's privacy (RJSF passes the field `schema`; read `schema.private === true`):
  - **private:** take `s.components?.locality ?? s.components?.city ?? s.label`, geocode that string (`getGeoProvider().suggest(cityQuery)` → first result) to get the **coarse** coord, and report it via `formContext.onLocationResolved`. Set the field text to the chosen address as usual.
  - **not private:** report `{ lat: s.lat, lng: s.lng }` (exactly what was picked), as today.
- [ ] **Step 2:** No-pick fallback unchanged (composite geocode on submit, handled in profile-form).
- [ ] **Step 3: Typecheck UI** → compiles.
- [ ] **Step 4: Commit.**
```bash
git add apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx
git commit -m "feat(ui): coarsen stored coord for private primary location fields"
```

### Task 13: schema-form — register multi widget, strip `"multi"`, pick widget

**Files:**
- Modify: `apps/ui/src/components/forms/schema-form.tsx`

- [ ] **Step 1:** Register: `widgets = { date, 'location-autocomplete': LocationAutocompleteWidget, 'location-multi': MultiLocationAutocompleteWidget }`.
- [ ] **Step 2:** In `generateUiSchema`, the existing geotagging branch checked `location === 'primary'` → rename it to `=== 'single'` (→ `'location-autocomplete'`), and add `else if (location === 'multiple')` → `'location-multi'`. Compose with `...((uiSchema[key] as object) ?? {})`.
- [ ] **Step 3:** In `normalizeSchemaForRjsf`, change the strip condition (currently `value === 'primary' || value === true`) to: `if (key === 'location' && (value === 'single' || value === 'multiple')) continue;`.
- [ ] **Step 4: Typecheck UI** → compiles.
- [ ] **Step 5: Commit.**
```bash
git add apps/ui/src/components/forms/schema-form.tsx
git commit -m "feat(ui): wire location:multi widget + strip the multi marker"
```

### Task 14: Profile form — `resolvedLocations[]`

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx`

- [ ] **Step 1:** Replace `resolvedCoords` state with `const [resolvedLocations, setResolvedLocations] = React.useState<Array<{lat;lng;label?}>>([])`. Pass `formContext={{ onLocationResolved: (c) => setResolvedLocations(c ? [c] : []), onLocationsResolved: setResolvedLocations }}` (single widget reports one coord → 1-element array; multi widget reports the set). Reset on domain change.
- [ ] **Step 2:** In `handleSubmit`, build `item_locations`: use `resolvedLocations` if non-empty; else fall back to geocoding via `buildLocationQueries(profileSchema, data)` → `getGeoProvider().suggest(query)` for each (mirrors backend). Attach top-level `item_locations` to the create/update payload (replace the old `item_latitude/longitude` attach).
- [ ] **Step 3:** `apps/ui/src/lib/item-api.ts` — `Item`, `CreateItemPayload`, `UpdateItemPayload` replace scalar coords with `item_locations: Array<{lat;lng;label?}>`.
- [ ] **Step 4: Typecheck UI** → compiles.
- [ ] **Step 5: Commit.**
```bash
git add apps/ui/src/pages/profile-form-page.tsx apps/ui/src/lib/item-api.ts
git commit -m "feat(ui): profile form builds item_locations array"
```

### Task 15: Map — one pin per location

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx`, `apps/ui/src/components/map/map-container.tsx`

- [ ] **Step 1:** `home-page.tsx` `itemToCardItem` (lines 42-52): replace `item_latitude/longitude` in `data` with `item_locations: item.item_locations`.
- [ ] **Step 2:** `map-container.tsx` `resolveMarkers` (lines 115-162): instead of one marker per item, iterate `item.data.item_locations` and emit one `MapMarker` per entry (id = `${item.id}#${i}`, lat/lng/label from the entry, sharing `item.data`/domain). Keep the geocode fallback (no `item_locations` → `buildLocationQueries` → geocode → markers). `spreadCoLocatedMarkers` still applies.
- [ ] **Step 3: Typecheck UI** → compiles.
- [ ] **Step 4: Commit.**
```bash
git add apps/ui/src/pages/home-page.tsx apps/ui/src/components/map/map-container.tsx
git commit -m "feat(ui): render one map pin per item_locations entry"
```

### Task 16: Action card list display + match-score number

**Files:**
- Modify: `apps/ui/src/components/actions/action-card.tsx`
- Modify: `apps/ui/src/lib/match-score-api.ts`

- [ ] **Step 1:** `action-card.tsx` — `otherParty` reads `*_item_locations` (array); `formatItemLocation` becomes a served-city list: join the entries' `label` (fallback to count) instead of `lat.toFixed,lng.toFixed`.
- [ ] **Step 2:** `match-score-api.ts` `itemToSnapshot` — derive `item_latitude/longitude` from `primaryLocation(item.item_locations)` (a number or null), keep sending those scalar fields (scorer unchanged); `item_state` already carries `service_cities`.
- [ ] **Step 3: Typecheck UI** → compiles cleanly (no remaining scalar refs).
- [ ] **Step 4: Commit.**
```bash
git add apps/ui/src/components/actions/action-card.tsx apps/ui/src/lib/match-score-api.ts
git commit -m "feat(ui): action card shows served-city list; match-score sends primaryLocation number"
```

---

## Phase 5 — Config + verification

### Task 17: purple_dot network.json + form layout

**Files:**
- Modify: `examples/schemas/purple_dot/network.json`
- Modify: `apps/ui/src/theme/form-layouts.ts`

- [ ] **Step 1:** **Rename every existing `"location": "primary"` marker → `"location": "single"`** across all networks: orange_dot `tourist.location` + `practitioner.area`; yellow_dot `student.Location`; blue_dot `seeker.location`; purple_dot `seeker.address` (keep its `"private": true` → coarsened). Drop any leftover `"location": true` secondaries. Then purple_dot **provider**: `service_cities` → `{ "type": "array", "title": "Service Cities", "description": "Cities where you provide services", "items": { "type": "string" }, "minItems": 1, "maxItems": 10, "location": "multiple" }`, and **remove the marker from `official_address`** (keep the field, required + private, not a geo field).
- [ ] **Step 2:** Run `pnpm --filter schemas test`. Update the example-config test: it asserts each domain has a geo field — assert `parseLocationFields(schema).field !== null` (now `single` or `multiple`) for the migrated domains.
- [ ] **Step 3:** `form-layouts.ts` — confirm provider layout lists `service_cities` (the multi widget renders there); no field removed.
- [ ] **Step 4:** `pnpm schema:bundle:check` (network.json is examples, not the DB bundle — should be unaffected; confirm).
- [ ] **Step 5: Commit.**
```bash
git add examples/schemas/purple_dot/network.json apps/ui/src/theme/form-layouts.ts packages/schemas/src/__tests__/example_network_configs.test.ts
git commit -m "feat(purple_dot): service_cities multi marker; address coarsened"
```

### Task 18: Full verification + manual

- [ ] **Step 1:** `pnpm typecheck` → 0 errors (api + ui). Fix any stragglers.
- [ ] **Step 2:** `pnpm --filter schemas test` and `pnpm --filter api test` → green.
- [ ] **Step 3:** `pnpm schema:bundle:check` → PASS.
- [ ] **Step 4:** Restart purple_dot locally (clear schema cache + redis, as in the geotagging run). Confirm `GET /api/v1/network/schemas?network=purple_dot` shows `service_cities` as `multi`.
- [ ] **Step 5: Manual:**
  - Provider form: add 2-3 service cities via autocomplete (city-level dropdown), submit; verify DB `item_locations` has one entry per city; map shows the provider card at each city; `official_address` not on the map.
  - Seeker form: pick an exact address (address-level dropdown); verify the stored `item_locations[0]` is **city/area-level** (not the door), and the map pin is coarse; address text masked.
  - API create (voice key from earlier): create a seeker with no `item_locations`, `item_state.address` a city → server geocodes → `item_locations` populated.
  - Radius search: `GET /item/fetch?...&item_latitude=<Goa>&item_longitude=<Goa>&radius_meters=50000` returns a provider serving Goa though based elsewhere.
- [ ] **Step 6:** Final commit of any fixups.

---

## Self-review notes
- **Spec coverage:** marker `multi` (T1,T13,T17); storage swap + migration (T2-T4); `item_locations` validation + keep search inputs (T4); create/geocode (T6); geosearch any-location (T7); fetch/inter-instance/profile (T8); action-event arrays (T9); provider level+components (T10); multi widget (T11); PII coarsening (T12); map multi-pin (T15); served-city display + match-score number (T16); config (T17); verify (T18). All spec sections mapped.
- **Type consistency:** `LocationPoint`/`{lat,lng,label?}` used uniformly; `parseLocationFields`→`{field,cardinality}`; `buildLocationQueries`→`[{query,label?}]`; `resolveItemLocations`; `primaryLocation`; `GeoSuggestion.components`; `suggest(query,signal)` (unrestricted, unchanged signature); `onLocationsResolved`.
- **Known follow-ups (out of scope):** aggregator-dpg/voice-dpg adopt the new response shape; in-radius pin filtering + location-search UI; spatial index for jsonb at scale.
