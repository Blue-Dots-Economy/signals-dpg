# Location fields: `primary` / `secondary` — Design

**Date:** 2026-06-15
**Branch:** `fix/signals-ui-fixes`
**Status:** Approved design — ready for implementation plan

## Goal

Replace the per-field `location: single | multiple` marker in `network.json`
item schemas with `location: primary | secondary`, separating two concerns
that are currently fused:

- **`primary`** — the one field per domain that is geocoded, stored as
  `item_locations`, and shown on the map. Also gets form autocomplete.
- **`secondary`** — a field that gets form autocomplete **only**. Never
  geocoded, never stored as a location, never shown on the map. Zero or more
  per domain.

Cardinality (one coordinate vs many) is **derived from the field's JSON Schema
`type`** (`array` → multiple, otherwise single) instead of being encoded in the
marker value.

**Motivating case:** the provider domain has an organisation address that
should offer autocomplete suggestions while the user types, but must **not**
drive the map pin (the provider's mappable location is a different field).

## Background — current state

`location: single | multiple` drives two concerns today:

1. **Form autocomplete widget** (`apps/ui/src/components/forms/schema-form.tsx`):
   a field marked `single` gets the `location-autocomplete` widget; `multiple`
   gets `location-multi`. The marker is stripped from the schema before RJSF
   sees it (`normalizeSchemaForRjsf`, matches `'single' | 'multiple'`).
2. **Geocode + map** (`packages/schemas/src/location_fields.ts`):
   `parseLocationFields` returns the **first** marked field as
   `{ field, cardinality }`; that single field is geocoded server-side on
   create (`resolve_locations_for_create.ts`, `geotag_item.ts`), coarsened if
   `private` (`item_service.ts`, `profile-form-page.tsx`), and used by the map
   marker fallback (`map-container.tsx`).

A test enforces **exactly one** location marker per served domain
(`packages/schemas/src/__tests__/example_network_configs.test.ts`). So today a
domain has exactly one field that is *both* autocompleted *and* mapped — hence
the "only one autocomplete field per domain" limitation.

## Decisions (locked)

- **Migration: hard cut.** Remove `single | multiple` support entirely; update
  all six `examples/schemas/*/network.json` files to `primary | secondary` in
  this work. Code + config ship together.
- **Validation: hard error.** A served domain's item schema must declare
  **exactly one `primary`** field. `0` or `≥2` primaries is a load-time
  rejection. `secondary` count is unbounded (`0+`).
- **Every served domain must have a `primary`** (matches today's "exactly one
  location field" contract). Secondary-only / no-map domains are out of scope.

## Design

### 1. Core model — `packages/schemas/src/location_fields.ts`

Replace the single-field result with a structured one:

```ts
export type LocationCardinality = 'single' | 'multiple';   // derived from `type`
export type LocationRole = 'primary' | 'secondary';

export interface LocationField {
  field: string;
  cardinality: LocationCardinality;
}

export interface LocationFields {
  primary: LocationField | null;   // geocode + map (exactly one when valid)
  secondary: LocationField[];      // autocomplete only (0+)
}
```

- **`parseLocationFields(itemSchema): LocationFields`** — iterate
  `properties`; classify each by its `location` value (`primary` / `secondary`);
  derive `cardinality` from `prop.type === 'array' ? 'multiple' : 'single'`.
  Returns the first `primary` found (validation guarantees ≤1) plus all
  `secondary` fields. Unknown/absent `location` → ignored.
- **`buildLocationQueries(data, primaryField: LocationField | null)`** — same
  logic as today but takes a single `LocationField` (the primary). `multiple`
  → one `{query,label}` per non-empty array entry; `single` → one `{query}`
  from the string. `null` → `[]`. **Secondary fields are never passed here.**
- **`isLocationFieldPrivate(itemSchema)`** — checks the **primary** field's
  `private === true`.
- **New: `getAutocompleteLocationFields(itemSchema): LocationField[]`** —
  returns `[primary, ...secondary]` (primary first when present). The form uses
  this to assign the autocomplete widget to every primary + secondary field.

### 2. Validation — load-time hard error

In the network-config load path (where `NetworkConfigSchema` /
`getNetworkConfigs` validates served domains), add a check: for each served
domain's item schema(s), count fields with `location === 'primary'`.

- `!== 1` → throw a clear error naming the network/domain and the count, so the
  API fails fast at load rather than serving a broken schema.
- Convert the existing `example_network_configs.test.ts` assertion from
  "exactly one location marker" to "exactly one `primary` marker (secondary
  unbounded)".

### 3. Form — `apps/ui/src/components/forms/schema-form.tsx`

- Assign the autocomplete widget to **every** field returned by
  `getAutocompleteLocationFields` (or equivalently, to any field whose
  `location` is `primary` or `secondary`):
  - `cardinality === 'single'` → `location-autocomplete`
  - `cardinality === 'multiple'` → `location-multi`
- Update `normalizeSchemaForRjsf` to strip the `location` marker when its value
  is `'primary' | 'secondary'` (was `'single' | 'multiple'`).

Net: the provider org address (secondary) gets autocomplete; the primary field
still gets autocomplete too.

### 4. Geocode + map — all consumers use `.primary`

Switch every geocode/map consumer to operate on `parseLocationFields(...).primary`:

- API: `apps/api/src/routes/v1/item/geotag_item.ts`,
  `apps/api/src/services/geocoding/resolve_locations_for_create.ts`,
  `apps/api/src/services/item_service.ts`.
- UI: `apps/ui/src/components/map/map-container.tsx`,
  `apps/ui/src/pages/profile-form-page.tsx`.

Secondary fields are never geocoded, never stored as `item_locations`, never
mapped — satisfying the org-address requirement.

> Note: the map fallback in `map-container.tsx` already uses the one-shot
> `geocode()` (committed earlier on this branch); this change only swaps the
> field-resolution to `.primary`.

### 5. `network.json` migration (hard cut)

For all six `examples/schemas/*/network.json`:

- Rename the existing geo field's marker `single | multiple` → `primary`
  (cardinality now implied by `type`).
- Mark the provider org-address field `location: secondary`.
- Verify each `primary` field's `type` matches its intended cardinality (array
  → multiple). Fix any mismatch.

## Deploy / operational notes (flagged, accepted)

1. **Schema cache must be cleared on deploy.** `network_schema_cache.ts` keys
   entries by `(kind, network, domain, itemType)` — **content-agnostic** — and
   `getConfiguredNetworkSchemas()` returns cached-if-present. A new
   `network.json` is **not** picked up until the cache is cleared: delete
   `tmpdir()/dpg-network-schema-cache`, restart the API (clears in-memory), and
   flush Redis. Fresh-container deploys (ephemeral `/tmp`) clear it naturally;
   in-place restarts do not. **Required deploy step.**
   - *Optional hardening (may include): fold a content hash into the schema
     cache key so any `network.json` edit auto-busts the cache.*
2. **Hard validation fails fast.** A migrated JSON with `0` or `≥2` primaries
   is rejected at load. Pre-deploy: the example-configs test + validation catch
   in-repo mistakes.
3. **Coupled rollback.** Code and `network.json` are coupled; roll back both
   together and clear the cache again.
4. **No item-data migration.** The marker is on the schema, not item data.
   Existing `item_locations` are untouched; secondary values are ordinary
   stored fields.

## Testing

- **Unit (`location_fields.test.ts`):** primary-only; primary + secondary;
  cardinality derived from `type` (string→single, array→multiple); secondary
  never appears in `buildLocationQueries`; `isLocationFieldPrivate` reads the
  primary; `getAutocompleteLocationFields` returns primary + all secondary.
- **Validation:** a schema with 0 primaries and one with 2 primaries both throw;
  update `example_network_configs.test.ts` to the exactly-one-primary rule.
- **Form:** a secondary field is assigned the autocomplete widget; the geocode
  query set excludes it.
- **API:** existing geocode/create tests pass with `.primary`; a secondary
  field does not produce an `item_locations` entry.

## Out of scope

- Server-side read enforcement / domain-scoped browse (separate concern).
- Per-domain split UIs (the next planned task).
- Domains with no map location (secondary-only); primary remains required.
- Granularity/level axis on autocomplete (none today; not added).
