# Multi-location items — providers on the map at every served city

**Status:** Design / ready for review (simplified single/multiple marker model)
**Date:** 2026-06-08
**Branch:** `feat/multi-location-items` (stacked on the geotagging branch; reuses the `location` marker system)
**Builds on:** the config-driven geotagging feature (PR #103).

## Problem

A purple_dot provider's map pin comes from their **address** (`official_address`). But the address is the provider's **private contact location** (force-masked PII), and a provider typically **serves multiple cities** beyond where they're based. Today:

- A provider based in Bengaluru who serves Goa and Hubli shows up on the map **only in Bengaluru**.
- A seeker looking at Goa never sees that provider — even though they serve Goa.
- `service_cities` exists but is a single free-text string and isn't used for anything.

We want a provider on the map at **all the cities they serve** (not the private address), found by location search at any of them — config-driven.

## Goals

1. A provider enters **multiple served cities** (configurable max), each via autocomplete.
2. The map shows the **same provider card at every served-city location**, **not** the private address.
3. Backend **radius geo-search matches a provider if any served city is in range**.
4. General and **config-driven**; single-location domains (seeker, orange/yellow/blue) keep working with one pin.

## The marker — one axis: cardinality

Exactly **one field per domain** is the geo field, marked:

| Marker | Field type | Produces |
|---|---|---|
| `"location": "single"` | string | **one** coordinate (e.g. seeker `address`, orange `location`/`area`) |
| `"location": "multiple"` | array of strings | **one coordinate per entry** (e.g. provider `service_cities`) |

- **No granularity/level axis.** Autocomplete is **unrestricted** — the user can type a full address *or* just a city ("Goa" → "Goa, India") and pick whichever; we geocode the pick. So a `single` field can hold a city or a street address, and a `multiple` field can hold cities or addresses — the user chooses per entry.
- **No secondary fields.** The geo field's value is self-sufficient (the old `location: true` composite concept is dropped).
- `parseLocationFields(schema)` → `{ field: string | null, cardinality: 'single' | 'multiple' | null }`.
- `buildLocationQueries(data, fields)` → `Array<{ query: string; label?: string }>`:
  - `multiple` → one `{query: entry, label: entry}` per non-empty array element.
  - `single` → one `{query: value}` from the field's string value.
  - else → `[]`.
  Pure; the caller geocodes each query → a `LocationPoint {lat,lng,label?}`.

Both live in `@dpg/schemas` (UI + API share them).

## PII coordinate coarsening (driven by `private: true`)

If the geo field is **`"private": true`**, we **never store the exact (door-level) coordinate** — we store a **coarse coordinate at locality/area level (else city)**, geocoded from the city/area, and the map renders only that coarse point.

- **UI:** the user picks their exact address (unrestricted autocomplete), but on selection — for a private field — we take the chosen place's **locality/area (else city)** from its address components and **geocode that** (`getGeoProvider().suggest(locality ?? city)` → first result), storing the coarse coordinate. The exact coordinate is **never stored**. Requires suggestions to carry address components (Google `Place.fetchFields(['location','addressComponents'])`; Photon `properties.{name,city,state,postcode,country}`).
- **Backend (API path, e.g. voice):** geocode the **provided string as-is** and store it. Voice usually supplies a city/area (already coarse). *Known limitation:* a non-voice API caller sending a full exact address for a private field isn't coarsened server-side — coarsening is enforced on the UI path.
- **Non-private fields:** geocode and store **exactly what was picked** (exact address or city).
- **Display:** the address *text* stays masked (`***`); only the **pin** uses the coarse stored coordinate.

For purple_dot this is mostly automatic: the provider's pins come from `service_cities` (cities) and `official_address` (PII) is never a geo field; the rule mainly protects the **seeker** (`address` = `single` + `private:true`), whose stored coordinate becomes locality/area-level.

## Data model

### `items`: replace the two scalars with one array
- **Drop** `item_latitude double precision` and `item_longitude double precision`.
- **Add** `item_locations jsonb` — `[{lat,lng,label?}]`, the single source of truth. `label` = the place/city name (map marker label + card "Serves: …" list).
- **Also dropped:** `items_geo_earth_idx` GiST index and the lat/lng CHECK constraints (range validation moves to **Zod**). Radius search becomes a seq-scan (acceptable at current scale).
- **Read-time helper** `primaryLocation(locations) = locations[0] ?? null` for single-point needs (no stored scalar).

### `action_events`: scalar snapshots → array snapshots
`source_item_latitude/longitude` + `target_item_latitude/longitude` become jsonb arrays **`source_item_locations`** / **`target_item_locations`** (with labels).

### Migration (hand-written raw SQL — not `db:generate`)
The GiST index + CHECK constraints live only in `create_items.sql` + the deploy bundle `schema.sql`, not in Drizzle. So: add `item_locations` jsonb, **backfill** existing rows (`[{lat,lng}]` from the scalars), **drop** the scalar columns + index + constraints — all as raw SQL; hand-edit `create_items.sql` + `create_actions_events.sql`; `pnpm schema:bundle` regenerates `schema.sql` (verified by `pnpm schema:bundle:check`). Drizzle handles only the column add/drop.

## network.json changes

- **All networks:** rename existing `"location": "primary"` markers → **`"location": "single"`** (orange tourist `location`, orange practitioner `area`, yellow student `Location`, blue seeker `location`, purple seeker `address`). Drop any leftover `"location": true` secondaries.
- **purple_dot provider:** `service_cities` → `{ "type": "array", "items": { "type": "string" }, "minItems": 1, "maxItems": 10, "location": "multiple" }`; **remove** the marker from `official_address` (stays required + private, not a geo field).
- **purple_dot seeker:** `address` keeps `"location": "single"` + `"private": true` → coarsened.

## UI

### Widgets (both use unrestricted autocomplete)
- **`single`** → the existing `LocationAutocompleteWidget` (one autocomplete; reports one coord). For a **private** field it coarsens on select (geocode the locality/city of the pick) and reports the coarse coord.
- **`multiple`** → new `MultiLocationAutocompleteWidget` (repeatable autocomplete rows up to `maxItems`; reports the coord set via `formContext.onLocationsResolved(Array<{lat,lng,label}>)`).
- `generateUiSchema` maps `location: "single"` → `location-autocomplete`, `location: "multiple"` → `location-multi`; the `location` keyword is stripped before the RJSF validator (extend the strip to the values `'single'`/`'multiple'`).

### Form page
`profile-form-page` holds `resolvedLocations: Array<{lat,lng,label}>` (single domains → 1-element). On submit it attaches top-level **`item_locations`** (never in `item_state`); a no-pick fallback geocodes `buildLocationQueries` results.

### Map
`map-container` emits **one marker per `item_locations` entry**, sharing the item's card/data. `home-page.itemToCardItem` carries `item_locations` into the map item shape. `spreadCoLocatedMarkers` handles overlaps. **No in-radius filtering** (the UI has no location-search input — all pins render). List/card view = **one card per item**, showing the served-city list (`formatCardValue` already joins arrays).

## API

- **Schemas (breaking):** stored + response shapes replace `item_latitude`/`item_longitude` with `item_locations: Array<{lat,lng,label?}>`. The item schemas are **drizzle-zod-derived**, so add `.$type<…>()` on the column + explicit `z.array(z.object({lat∈[-90,90], lng∈[-180,180], label?})).optional()` overrides on the derived create/update/response schemas. Affects `item_schemas.ts`, `action_schemas.ts`, UI clients (`item-api.ts`, `action-api.ts`). **Keep `FetchItemsQuerySchema`'s `item_latitude`/`item_longitude`/`radius_meters` as geo-search INPUT params** (the EXISTS clause needs a center). External fetch consumers (aggregator-dpg, voice-dpg) update afterward.
- **create/update + `item_service`:** persist `item_locations`; when absent, geocode via `buildLocationQueries` (best-effort, never blocks creation).
- **Geo-search** (`item_fetch_runtime.buildWhereClause`): match **any** location —
  ```sql
  EXISTS (SELECT 1 FROM jsonb_array_elements(item_locations) loc
    WHERE earth_box(ll_to_earth($lat,$lng), $r) @> ll_to_earth((loc->>'lat')::float8,(loc->>'lng')::float8)
      AND earth_distance(ll_to_earth($lat,$lng), ll_to_earth((loc->>'lat')::float8,(loc->>'lng')::float8)) <= $r)
  ```
- **Action-event snapshots:** store `source_item_locations` / `target_item_locations` arrays.
- **Match-score (external scorer unchanged):** the snapshot keeps sending `item_latitude`/`item_longitude` as a **number** derived via `primaryLocation(item_locations)` — **never the array** (the scorer's schema requires `z.number()`; an array is rejected). `item_state.service_cities` already reaches the scorer. Verified against `ONEST-Network/dpg-scoring`.

## Interaction model (item-level)
A provider is one item rendered as N pins. Connecting links the seeker *item* to the provider *item* by ID (coords don't affect it). **One connection per provider** (no duplicate connects across pins; all pins reflect "connected" — implementation must ensure backend dedup). Cards/action cards show the served-city list. We do **not** capture which pin was clicked (no per-city context); match-score gets the derived `primaryLocation` number + `service_cities`.

## Error handling
- A geocode failure for an entry is skipped (best-effort); creation never blocked.
- PII-mask guard retained on geocode queries.
- `maxItems` (10) + coordinate ranges enforced by Zod.

## Testing
- **Unit (`@dpg/schemas`):** `parseLocationFields` (single/multiple); `buildLocationQueries` (multiple → per entry; single → one; none → empty); `item_locations` range validation.
- **Unit (API):** geosearch matches any array entry; `resolveItemLocations` (provided passthrough; multiple per-city w/ label skipping failures; single; none); `primaryLocation`.
- **Integration (API):** provider with multiple cities → `item_locations` populated; Goa radius search returns a Bengaluru-based provider serving Goa; backfill produces 1-element arrays.
- **Manual:** provider form multi-city autocomplete (≤10) → card at each city, not the address; seeker private address → stored coarse (area/city), pin coarse, text masked; voice API create geocodes the string; legacy items render.

## Out of scope / follow-ups
- Coordinated external update of aggregator-dpg + voice-dpg to the `item_locations` response shape.
- A location-search UI + in-radius pin filtering.
- A spatial index for the jsonb points at scale.
- Other networks beyond the marker rename + backfill (stay single-location).
