# Location `primary` / `secondary` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `location: single|multiple` field marker with `location: primary|secondary`, so a domain can have one geocoded+mapped field (`primary`) plus any number of autocomplete-only fields (`secondary`); cardinality is derived from the JSON Schema `type`.

**Architecture:** A pure module in `packages/schemas` (`location_fields.ts`) classifies fields and is consumed by the API geocoder, the UI map, and the form. The form assigns the autocomplete widget to primary+secondary fields but flags only the primary so its picked coordinates feed `item_locations`; secondary picks stay ordinary field values. A load-time validator rejects any served domain that doesn't declare exactly one `primary`.

**Tech Stack:** TypeScript (ESM, strict), Zod, Vitest, React 19 + RJSF (`@rjsf`), pnpm + Turborepo. Branch: `fix/signals-ui-fixes`.

**Spec:** `docs/superpowers/specs/2026-06-15-location-primary-secondary-design.md`

**Commands:**
- Schemas tests: `pnpm --filter schemas test`
- API tests: `pnpm --filter api test`
- UI tests: `pnpm --filter ui exec vitest run <file>`
- Typecheck everything: `pnpm typecheck`

**Note on Codacy:** CLAUDE.md asks to run `codacy_cli_analyze` after edits. The Codacy MCP is not connected in this environment; skip it (typecheck + tests are the gate). If it is available in yours, run it on edited files.

**Note on the motivating "org address":** blue_dot `provider/job_posting_1.0` has only `jobProviderLocation` (which becomes the `primary`); there is no separate org-address field today. This plan delivers and tests the `secondary` capability; marking a specific field `secondary` is a one-line config edit applied when such a field exists. No real network.json gains a `secondary` marker here.

---

## File Structure

- `packages/schemas/src/location_fields.ts` — **core**. New `LocationFields = { primary, secondary }`, `LocationField`, cardinality-from-type, `buildLocationQueries(data, primary)`, `isLocationFieldPrivate` (reads primary), new `getAutocompleteLocationFields`, new `assertSinglePrimaryLocation`.
- `packages/schemas/src/index.ts` — export the new symbols.
- `packages/schemas/src/__tests__/location_fields.test.ts` — rewrite for the new shape.
- `packages/schemas/src/__tests__/example_network_configs.test.ts` — assert exactly one `primary`.
- `apps/api/src/routes/v1/item/geotag_item.ts`, `apps/api/src/services/geocoding/resolve_locations_for_create.ts` — pass `.primary`.
- `apps/api/src/network_configs.ts` — call the validator at load.
- `apps/ui/src/components/map/map-container.tsx`, `apps/ui/src/pages/profile-form-page.tsx` — pass `.primary`.
- `apps/ui/src/components/forms/schema-form.tsx` — assign widget to primary+secondary; flag primary; strip `primary|secondary`.
- `apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx`, `multi-location-autocomplete-widget.tsx` — gate resolve callbacks on `options.isPrimaryLocation`.
- `examples/schemas/{blue_dot,orange_dot,purple_dot,yellow_dot}/network.json` — migrate markers to `primary` (`single|multiple` → `primary`).
- `apps/api/src/services/item_service.ts` — **no change** (`isLocationFieldPrivate` keeps its signature).

---

### Task 1: Core model + geocode/map call-site updates

This task changes `parseLocationFields`' return shape and `buildLocationQueries`' signature, then updates all four geocode/map callers in the same commit so the tree compiles.

**Files:**
- Modify: `packages/schemas/src/location_fields.ts`
- Modify: `packages/schemas/src/index.ts`
- Test: `packages/schemas/src/__tests__/location_fields.test.ts`
- Modify: `apps/api/src/routes/v1/item/geotag_item.ts`
- Modify: `apps/api/src/services/geocoding/resolve_locations_for_create.ts`
- Modify: `apps/ui/src/components/map/map-container.tsx`
- Modify: `apps/ui/src/pages/profile-form-page.tsx`

- [ ] **Step 1: Replace `location_fields.ts` with the new model**

```ts
/**
 * Marker-driven location-field selection.
 *
 *   "location": "primary"   — the ONE field per domain that is geocoded,
 *                             stored as item_locations, and shown on the map.
 *                             Also gets form autocomplete.
 *   "location": "secondary" — a field that gets form autocomplete ONLY; never
 *                             geocoded, stored, or mapped. Zero or more per domain.
 *
 * Cardinality (one coordinate vs many) is derived from the field's JSON Schema
 * `type`: `array` -> multiple, otherwise single. Shared by the UI (form + map)
 * and the API (server-side geocode).
 */
export type LocationCardinality = 'single' | 'multiple';
export type LocationRole = 'primary' | 'secondary';

export interface LocationField {
  field: string;
  cardinality: LocationCardinality;
}

export interface LocationFields {
  /** The geo field (geocode + map). Null when no field is marked primary. */
  primary: LocationField | null;
  /** Autocomplete-only fields. */
  secondary: LocationField[];
}

/** One coordinate. `label` is the place/city name when known. */
export interface LocationPoint {
  lat: number;
  lng: number;
  label?: string;
}

type JsonSchemaProperty = { location?: unknown; private?: unknown; type?: unknown };

function cardinalityOf(prop: JsonSchemaProperty): LocationCardinality {
  return prop?.type === 'array' ? 'multiple' : 'single';
}

export function parseLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationFields {
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  let primary: LocationField | null = null;
  const secondary: LocationField[] = [];
  for (const [name, prop] of Object.entries(properties)) {
    if (prop?.location === 'primary') {
      // Validation guarantees at most one; first wins defensively.
      primary ??= { field: name, cardinality: cardinalityOf(prop) };
    } else if (prop?.location === 'secondary') {
      secondary.push({ field: name, cardinality: cardinalityOf(prop) });
    }
  }
  return { primary, secondary };
}

/** Primary + secondary fields (primary first) — the fields that get autocomplete. */
export function getAutocompleteLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationField[] {
  const { primary, secondary } = parseLocationFields(itemSchema);
  return primary ? [primary, ...secondary] : secondary;
}

/**
 * True when the primary location field carries `"private": true`. Used by the
 * geocode paths to coarsen exact coordinates for a PII field.
 */
export function isLocationFieldPrivate(
  itemSchema: Record<string, unknown> | null | undefined
): boolean {
  const { primary } = parseLocationFields(itemSchema);
  if (!primary) return false;
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  return properties[primary.field]?.private === true;
}

/**
 * The geocode queries that produce the item's locations, from the PRIMARY field
 * only (secondary fields are never geocoded):
 *   - multiple -> one {query,label} per non-empty array entry (label = value).
 *   - single   -> one {query} from the field's string value.
 *   - null     -> [].
 */
export function buildLocationQueries(
  data: Record<string, unknown>,
  primary: LocationField | null
): Array<{ query: string; label?: string }> {
  if (!primary) return [];
  const raw = data[primary.field];
  if (primary.cardinality === 'multiple') {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
      .map((v) => ({ query: v.trim(), label: v.trim() }));
  }
  return typeof raw === 'string' && raw.trim() ? [{ query: raw.trim() }] : [];
}

/**
 * Throws when an item schema does not declare exactly one `primary` location
 * field. Called at network-config load so a misconfigured network fails fast.
 */
export function assertSinglePrimaryLocation(
  itemSchema: Record<string, unknown> | null | undefined,
  context: string
): void {
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;
  const primaryCount = Object.values(properties).filter(
    (p) => p?.location === 'primary'
  ).length;
  if (primaryCount !== 1) {
    throw new Error(
      `${context}: item schema must declare exactly one "location": "primary" field, found ${primaryCount}.`
    );
  }
}
```

- [ ] **Step 2: Export the new symbols from `index.ts`**

Replace the existing `location_fields` export block (around lines 29-36) with:

```ts
export {
  parseLocationFields,
  buildLocationQueries,
  isLocationFieldPrivate,
  getAutocompleteLocationFields,
  assertSinglePrimaryLocation,
  type LocationFields,
  type LocationField,
  type LocationCardinality,
  type LocationRole,
  type LocationPoint,
} from './location_fields';
```

- [ ] **Step 3: Rewrite the unit test**

Replace `packages/schemas/src/__tests__/location_fields.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import {
  parseLocationFields,
  buildLocationQueries,
  isLocationFieldPrivate,
  getAutocompleteLocationFields,
  assertSinglePrimaryLocation,
} from '../location_fields';

const primaryString = {
  properties: { address: { type: 'string', location: 'primary' } },
};
const primaryArray = {
  properties: { service_cities: { type: 'array', location: 'primary' } },
};
const withSecondary = {
  properties: {
    address: { type: 'string', location: 'primary', private: true },
    orgAddress: { type: 'string', location: 'secondary' },
    serviceAreas: { type: 'array', location: 'secondary' },
  },
};

describe('parseLocationFields', () => {
  it('reads a single primary (cardinality from string type)', () => {
    expect(parseLocationFields(primaryString)).toEqual({
      primary: { field: 'address', cardinality: 'single' },
      secondary: [],
    });
  });

  it('derives multiple cardinality from array type', () => {
    expect(parseLocationFields(primaryArray).primary).toEqual({
      field: 'service_cities',
      cardinality: 'multiple',
    });
  });

  it('collects secondary fields with their cardinality', () => {
    const { primary, secondary } = parseLocationFields(withSecondary);
    expect(primary).toEqual({ field: 'address', cardinality: 'single' });
    expect(secondary).toEqual([
      { field: 'orgAddress', cardinality: 'single' },
      { field: 'serviceAreas', cardinality: 'multiple' },
    ]);
  });

  it('returns null primary when none is marked', () => {
    expect(parseLocationFields({ properties: { name: { type: 'string' } } })).toEqual({
      primary: null,
      secondary: [],
    });
  });
});

describe('getAutocompleteLocationFields', () => {
  it('returns primary first, then all secondary', () => {
    expect(getAutocompleteLocationFields(withSecondary).map((f) => f.field)).toEqual([
      'address',
      'orgAddress',
      'serviceAreas',
    ]);
  });
});

describe('buildLocationQueries (primary only)', () => {
  it('single primary -> one query from the string', () => {
    expect(
      buildLocationQueries({ address: 'Mumbai' }, { field: 'address', cardinality: 'single' })
    ).toEqual([{ query: 'Mumbai' }]);
  });

  it('multiple primary -> one query+label per entry', () => {
    expect(
      buildLocationQueries(
        { service_cities: ['Pune', ' Mumbai '] },
        { field: 'service_cities', cardinality: 'multiple' }
      )
    ).toEqual([
      { query: 'Pune', label: 'Pune' },
      { query: 'Mumbai', label: 'Mumbai' },
    ]);
  });

  it('null primary -> no queries (secondary never geocoded)', () => {
    expect(buildLocationQueries({ orgAddress: 'X' }, null)).toEqual([]);
  });
});

describe('isLocationFieldPrivate', () => {
  it('reads the primary field private flag', () => {
    expect(isLocationFieldPrivate(withSecondary)).toBe(true);
    expect(isLocationFieldPrivate(primaryString)).toBe(false);
  });
});

describe('assertSinglePrimaryLocation', () => {
  it('passes with exactly one primary', () => {
    expect(() => assertSinglePrimaryLocation(withSecondary, 'net/dom/type')).not.toThrow();
  });
  it('throws with zero primaries', () => {
    expect(() =>
      assertSinglePrimaryLocation({ properties: { a: { type: 'string' } } }, 'net/dom/type')
    ).toThrow(/exactly one .* found 0/);
  });
  it('throws with two primaries', () => {
    expect(() =>
      assertSinglePrimaryLocation(
        { properties: { a: { type: 'string', location: 'primary' }, b: { type: 'string', location: 'primary' } } },
        'net/dom/type'
      )
    ).toThrow(/found 2/);
  });
});
```

- [ ] **Step 4: Run the schemas test — expect PASS** (the core is implemented)

Run: `pnpm --filter schemas exec vitest run src/__tests__/location_fields.test.ts`
Expected: all tests pass. (`example_network_configs.test.ts` will still fail — fixed in Task 2; don't run the whole suite yet.)

- [ ] **Step 5: Update `geotag_item.ts` to pass the primary**

In `apps/api/src/routes/v1/item/geotag_item.ts`, replace:

```ts
  const fields = parseLocationFields(args.itemSchema);
  const queries = buildLocationQueries(args.itemState, fields);
```
with:
```ts
  const { primary } = parseLocationFields(args.itemSchema);
  const queries = buildLocationQueries(args.itemState, primary);
```

- [ ] **Step 6: Update `resolve_locations_for_create.ts` to pass the primary**

In `apps/api/src/services/geocoding/resolve_locations_for_create.ts`:

Replace the private-field block:
```ts
      const { field } = parseLocationFields(itemSchema);
      const address = field ? args.item_state[field] : undefined;
```
with:
```ts
      const { primary } = parseLocationFields(itemSchema);
      const address = primary ? args.item_state[primary.field] : undefined;
```

Replace the public-field block:
```ts
    const fields = parseLocationFields(itemSchema);
    const queries = buildLocationQueries(args.item_state, fields);
```
with:
```ts
    const { primary } = parseLocationFields(itemSchema);
    const queries = buildLocationQueries(args.item_state, primary);
```

- [ ] **Step 7: Update `map-container.tsx` to pass the primary**

In `apps/ui/src/components/map/map-container.tsx`, replace:
```ts
            const fields = parseLocationFields(schema as Record<string, unknown>);
            const queries = buildLocationQueries(item.data, fields);
```
with:
```ts
            const { primary } = parseLocationFields(schema as Record<string, unknown>);
            const queries = buildLocationQueries(item.data, primary);
```

- [ ] **Step 8: Update `profile-form-page.tsx` to pass the primary**

In `apps/ui/src/pages/profile-form-page.tsx`, replace:
```ts
        const fields = parseLocationFields(profileSchema as Record<string, unknown>);
        const queries = buildLocationQueries(data, fields);
```
with:
```ts
        const { primary } = parseLocationFields(profileSchema as Record<string, unknown>);
        const queries = buildLocationQueries(data, primary);
```

- [ ] **Step 9: Typecheck the whole repo — expect PASS**

Run: `pnpm typecheck`
Expected: exit 0 (api tsc + ui tsc clean). If `parseLocationFields(...).field` is referenced anywhere else it will surface here; there should be none beyond the four sites above.

- [ ] **Step 10: Commit**

```bash
git add packages/schemas/src/location_fields.ts packages/schemas/src/index.ts \
  packages/schemas/src/__tests__/location_fields.test.ts \
  apps/api/src/routes/v1/item/geotag_item.ts \
  apps/api/src/services/geocoding/resolve_locations_for_create.ts \
  apps/ui/src/components/map/map-container.tsx \
  apps/ui/src/pages/profile-form-page.tsx
git commit -m "refactor(location): model primary/secondary fields; geocode uses primary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Load-time exactly-one-primary validation

**Files:**
- Modify: `apps/api/src/network_configs.ts`
- Test: `packages/schemas/src/__tests__/example_network_configs.test.ts`

- [ ] **Step 1: Wire the validator into config load**

In `apps/api/src/network_configs.ts`, update the import and `loadAndParseNetworkConfigs`:

```ts
import {
  type NetworkConfigDocument,
  parseNetworkConfigDocument,
  assertSinglePrimaryLocation,
} from '@dpg/schemas';
```

Replace:
```ts
  return configs.map((config) => parseNetworkConfigDocument(config));
```
with:
```ts
  return configs.map((config) => {
    const parsed = parseNetworkConfigDocument(config);
    for (const domain of parsed.domains) {
      for (const [itemType, itemSchema] of Object.entries(domain.item_schemas)) {
        assertSinglePrimaryLocation(
          itemSchema as Record<string, unknown>,
          `${parsed.id}/${domain.id}/${itemType}`,
        );
      }
    }
    return parsed;
  });
```

- [ ] **Step 2: Update the example-config assertion to the primary rule**

In `packages/schemas/src/__tests__/example_network_configs.test.ts`, replace the block that asserts `fields.field` is non-null and counts `single|multiple` markers with:

```ts
      const fields = parseLocationFields(schema);
      expect(
        fields.primary,
        `${network}/${domainId} has no primary location field`,
      ).not.toBeNull();

      const properties = schema.properties as Record<
        string,
        { location?: unknown }
      >;
      const primaryCount = Object.values(properties).filter(
        (p) => p?.location === 'primary',
      ).length;
      expect(
        primaryCount,
        `${network}/${domainId} must have exactly one primary location marker, found ${primaryCount}`,
      ).toBe(1);
```

> This test reads the served example configs; it will FAIL until Task 5 migrates the JSON. That is expected — run the full schemas suite at the end of Task 5.

- [ ] **Step 3: Typecheck — expect PASS**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/network_configs.ts \
  packages/schemas/src/__tests__/example_network_configs.test.ts
git commit -m "feat(location): reject configs without exactly one primary at load

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Form — assign widget to primary+secondary, flag primary, strip new marker

**Files:**
- Modify: `apps/ui/src/components/forms/schema-form.tsx`

- [ ] **Step 1: Replace the widget-assignment blocks**

In `generateUiSchema`, replace:
```ts
    if ((typed as { location?: unknown }).location === 'single') {
      uiSchema[key] = { ...((uiSchema[key] as object) ?? {}), 'ui:widget': 'location-autocomplete' };
    }

    if ((typed as { location?: unknown }).location === 'multiple') {
      uiSchema[key] = { ...((uiSchema[key] as object) ?? {}), 'ui:widget': 'location-multi' };
    }
```
with:
```ts
    const locationRole = (typed as { location?: unknown }).location;
    if (locationRole === 'primary' || locationRole === 'secondary') {
      const isArray = (typed as { type?: unknown }).type === 'array';
      const existing = (uiSchema[key] as Record<string, unknown>) ?? {};
      const existingOptions = (existing['ui:options'] as Record<string, unknown>) ?? {};
      uiSchema[key] = {
        ...existing,
        'ui:widget': isArray ? 'location-multi' : 'location-autocomplete',
        // Only the primary field's picked coordinate feeds item_locations;
        // secondary fields are autocomplete-only.
        'ui:options': { ...existingOptions, isPrimaryLocation: locationRole === 'primary' },
      };
    }
```

- [ ] **Step 2: Update the marker strip in `normalizeSchemaForRjsf`**

Replace:
```ts
    if (key === 'location' && (value === 'single' || value === 'multiple')) continue;
```
with:
```ts
    if (key === 'location' && (value === 'primary' || value === 'secondary')) continue;
```

- [ ] **Step 3: Typecheck — expect PASS**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/forms/schema-form.tsx
git commit -m "feat(form): autocomplete widget for primary+secondary; flag primary

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Gate widget resolve callbacks on `isPrimaryLocation`

Without this, a secondary field's typing/selection would call the shared `onLocationResolved`/`onLocationsResolved` callbacks and overwrite the primary's `item_locations`.

**Files:**
- Modify: `apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx`
- Modify: `apps/ui/src/components/forms/custom-widgets/multi-location-autocomplete-widget.tsx`

- [ ] **Step 1: Gate the single-location widget**

In `location-autocomplete-widget.tsx`, add `options` to the destructured `WidgetProps` (alongside `formContext`):
```ts
  onChange,
  rawErrors,
  formContext,
  options,
}: WidgetProps) {
  const ctx = (formContext ?? {}) as LocationFormContext;
  const isPrimary = (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;
```

In `handleInput`, gate the reset:
```ts
    // The freshly typed text is no longer a resolved place — drop prior coords
    // so the submit-time fallback re-geocodes (or the next selection sets them).
    // Only the primary field feeds item_locations.
    if (isPrimary) ctx.onLocationResolved?.(null);
```

In `choose`, gate the report:
```ts
    if (isPrimary) {
      ctx.onLocationResolved?.({ lat: s.lat, lng: s.lng, components: s.components });
    }
```

- [ ] **Step 2: Gate the multi-location widget**

In `multi-location-autocomplete-widget.tsx`, add `options` to the destructured `WidgetProps`:
```ts
  formContext,
  options,
}: WidgetProps) {
  const ctx = (formContext ?? {}) as LocationFormContext;
  const isPrimary = (options as { isPrimaryLocation?: boolean } | undefined)?.isPrimaryLocation === true;
```

Gate the resolved-coords report (currently `ctx.onLocationsResolved?.(coords);` at ~line 163):
```ts
    if (isPrimary) ctx.onLocationsResolved?.(coords);
```
If there are other `ctx.onLocationsResolved?.(...)` / `ctx.onLocationResolved?.(...)` calls in this file (e.g. a reset on edit), gate each identically with `if (isPrimary)`.

- [ ] **Step 3: Typecheck — expect PASS**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx \
  apps/ui/src/components/forms/custom-widgets/multi-location-autocomplete-widget.tsx
git commit -m "fix(form): only the primary location field feeds item_locations

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Migrate example network.json markers (`single|multiple` → `primary`)

**Files:**
- Modify: `examples/schemas/blue_dot/network.json`
- Modify: `examples/schemas/orange_dot/network.json`
- Modify: `examples/schemas/purple_dot/network.json`
- Modify: `examples/schemas/yellow_dot/network.json`

The two `examples/schemas/inter-network-action/*` files have no location markers and are not served — leave them untouched.

- [ ] **Step 1: Edit each marker** — in every file below, change the field's `"location": "single"` or `"location": "multiple"` to `"location": "primary"` (the value is the only thing that changes; `type`/`private` stay as-is, since cardinality now derives from `type`):

  - `blue_dot`: `seeker/profile_1.0` field `location` (`single`→`primary`); `provider/job_posting_1.0` field `jobProviderLocation` (`single`→`primary`).
  - `orange_dot`: `practitioner/profile_1.0` field `area` (`single`→`primary`).
  - `purple_dot`: `seeker/profile_1.0` field `address` (`single`→`primary`); `provider/profile_1.0` field `service_cities` (`multiple`→`primary`, `type:"array"` already implies multiple).
  - `yellow_dot`: `student/profile_1.0` field `Location` (`single`→`primary`).

- [ ] **Step 2: Verify no stale markers remain**

Run:
```bash
grep -rn '"location": *"single"\|"location": *"multiple"' examples/schemas
```
Expected: no output (all migrated).

- [ ] **Step 3: Run the full schemas test suite — expect PASS**

Run: `pnpm --filter schemas test`
Expected: `location_fields.test.ts` and `example_network_configs.test.ts` pass (every served domain now has exactly one `primary`).

- [ ] **Step 4: Commit**

```bash
git add examples/schemas/blue_dot/network.json examples/schemas/orange_dot/network.json \
  examples/schemas/purple_dot/network.json examples/schemas/yellow_dot/network.json
git commit -m "chore(config): migrate location markers to primary (hard cut)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Full verification + deploy note

**Files:** none (verification only).

- [ ] **Step 1: Typecheck everything**

Run: `pnpm typecheck`
Expected: exit 0.

- [ ] **Step 2: Run API + schemas test suites**

Run:
```bash
pnpm --filter schemas test
pnpm --filter api test
```
Expected: pass (geotag/create geocoding tests still green with `.primary`).

- [ ] **Step 3: Manual smoke (local, purple_dot)**

With the API + signals UI running on purple_dot:
- Open the provider profile form → the `service_cities` field (primary) shows autocomplete and its picks geocode/appear on the map.
- A field marked `location: secondary` (add one temporarily to a local copy if verifying) shows autocomplete but never produces a map pin / `item_locations`.
- Confirm the map still renders existing provider items (stored `item_locations` unaffected).

- [ ] **Step 4: Record the deploy-time cache-bust requirement**

The schema cache (`network_schema_cache.ts`) is content-agnostic and returns cached-if-present, so deploying the migrated `network.json` is **not** enough on a non-ephemeral host. On deploy:
- Delete `tmpdir()/dpg-network-schema-cache`.
- Restart the API (clears the in-memory layer).
- Flush Redis (`FLUSHALL` or targeted delete) to be safe.

Fresh-container deploys (ephemeral `/tmp`) clear the on-disk cache automatically. Ensure this step is in the deploy runbook for this change. (Optional follow-up, not in this plan: fold a content hash into the schema cache key so config edits auto-bust.)

- [ ] **Step 5: Final confirmation**

No code to commit. Confirm `git log --oneline` shows Tasks 1–5 commits on `fix/signals-ui-fixes` and the working tree is clean.

---

## Self-Review

**Spec coverage:**
- primary = geocode+map+autocomplete → Task 1 (`buildLocationQueries` uses primary; consumers pass `.primary`), Task 3 (widget on primary), Task 4 (primary feeds item_locations). ✅
- secondary = autocomplete only → Task 3 (widget assigned), Task 4 (callbacks gated off for secondary). ✅
- cardinality from `type` → Task 1 (`cardinalityOf`), Task 3 (array → `location-multi`). ✅
- hard cut → Task 5 migrates all served configs; Task 1/3 remove `single|multiple` handling. ✅
- hard validation (exactly one primary) → Task 2. ✅
- deploy cache-bust → Task 6 Step 4. ✅
- `item_service.ts` unchanged (signature of `isLocationFieldPrivate` preserved) → noted in File Structure. ✅

**Placeholder scan:** No TBD/TODO; every code step shows complete before/after. The only conditional ("if there are other `onLocationsResolved` calls") names the exact treatment (`if (isPrimary)`). ✅

**Type consistency:** `LocationField {field,cardinality}`, `LocationFields {primary,secondary}`, `buildLocationQueries(data, primary: LocationField|null)`, `assertSinglePrimaryLocation(itemSchema, context)`, `getAutocompleteLocationFields` — names match across Tasks 1, 2, 3, 4, and the tests. `ui:options.isPrimaryLocation` is set in Task 3 and read in Task 4 under the same key. ✅
