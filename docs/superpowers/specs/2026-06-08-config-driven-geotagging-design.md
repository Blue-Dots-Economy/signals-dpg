# Config-driven geotagging with address autocomplete

**Status:** Design / pending implementation
**Date:** 2026-06-08
**Branch:** `feat/config-driven-geotagging`

## Problem

Today, lat/lng tagging of profile items has two weaknesses:

1. **Field selection is a hardcoded heuristic.** `apps/ui/src/lib/item-utils.ts` guesses which schema
   field is the address by matching against hardcoded name lists (`location`, `address`, `area`, `city`,
   `pincode`, …) and fuzzy tokens. It "works" only because each network happens to name its fields with a
   recognised token. A field named outside the lists is silently skipped, and the network schema never
   declares its own location field.
2. **Geocoding only happens in the UI.** Lat/lng is computed in the browser at submit time
   (`profile-form-page.tsx` → `extractAndGeocode`). Items created directly through the API
   (`POST /api/v1/item/create`) are never geotagged.

Additionally, free-text address entry is typo-prone, which produces wrong coordinates.

## Goals

1. Let each network **declare its location field(s)** in `network.json` instead of relying on hardcoded keys.
2. Use that declared field to obtain lat/lng and attach it to the create-item payload, using **Google Places
   autocomplete** to avoid typos in the address.
3. Provide a **free, key-less fallback** (Photon / OpenStreetMap) for deployments without a Google API key.
4. Geotag items created **via the API**, not just via the UI, using the same declared field.

## Non-goals

- Auto-filling secondary fields (city/state/pincode) from the chosen suggestion. Explicitly dropped to keep
  the marker simple — can be added later via a richer marker vocabulary.
- Reverse-geocoding or backfilling coordinates for items that already exist. Only new creates are geotagged.
- Self-hosting Photon (we use the public endpoint; the base URL is configurable for later).

## The marker

A new `location` keyword on a JSON-Schema property inside `network.json`:

| Marker | Count per profile schema | Purpose |
|---|---|---|
| `"location": "primary"` | **exactly one** | Hosts the autocomplete widget. The picked suggestion provides the authoritative lat/lng. Leads the composite geocode query. |
| `"location": true` | **zero or more** | Secondary address fields. **Not** autocompleted individually; their values are appended to the composite geocode query to improve accuracy on the fallback/backend paths only. |

No per-field roles. A network with a single address field just marks it `"primary"`.

Example — purple_dot `seeker`:

```jsonc
"address":      { "type": "string", "location": "primary" },
"service_city": { "type": "string", "location": true },
"district":     { "type": "string", "location": true },
"state":        { "type": "string", "location": true },
"pincode":      { "type": "string", "location": true }
```

Example — orange_dot `tourist` (single field):

```jsonc
"location": { "type": "string", "location": "primary" }
```

### Validation compatibility (verified)

- **Zod** (`packages/schemas/src/network_workflow.ts`): item schemas are typed
  `z.record(z.string(), z.unknown())` (`JsonSchemaDocumentSchema`), so the `location` keyword passes through
  untouched.
- **API-side Ajv** (`network_workflow.ts` validator) runs with `strict: false`; unknown keyword is ignored.
- **RJSF ajv8 validator** (`apps/ui/src/components/forms/schema-form.tsx`): the `location` keyword is **read
  to drive widget selection, then stripped from the schema before it reaches the RJSF validator**, to avoid
  unknown-keyword warnings. (Extend the existing `normalizeSchemaForRjsf` / `stripMetaSchema` step.)

### Migration scope

Add markers to all four networks: `orange_dot`, `purple_dot`, `yellow_dot`, `blue_dot`
(`examples/schemas/<network>/network.json`). Each profile schema gets exactly one `"primary"` and any
secondary `true` fields. Switching networks locally requires clearing the schema cache (see Operational
notes).

## Architecture

### Shared geo-provider layer (frontend)

A single interface so the form and the map share one code path, working with or without an API key:

```ts
interface GeoSuggestion { label: string; lat: number; lng: number; }
interface GeoProvider {
  suggest(query: string, signal?: AbortSignal): Promise<GeoSuggestion[]>;
}
```

- **GooglePlacesProvider** — used when `VITE_GOOGLE_MAPS_API_KEY` is present. Uses the **Places Autocomplete
  Data API** (`AutocompleteSuggestion.fetchAutocompleteSuggestions`) for predictions and
  `Place.fetchFields(['location'])` to resolve coordinates for the chosen prediction, with a session token
  for billing. Rendered in our own shadcn dropdown so Google and Photon results look identical.
  - *Alternative considered and rejected:* Google's `PlaceAutocompleteElement` web component — it cannot
    render Photon results, which would force two divergent UIs.
  - *Cost note:* Places Autocomplete (New) + Place Details bills per session — pricier than plain Geocoding.
    This is the deliberate trade for typo-proof input. Free monthly allotments apply; Photon path is free.
- **PhotonProvider** — fallback when no key. `GET {PHOTON_URL}/api?q=…&limit=5`
  (default `https://photon.komoot.io`). Each feature already carries `geometry.coordinates` + label
  properties, so there is **no second call** and it is **free**.

Provider selection: Google when the key is present, otherwise Photon.

This layer reorganises the existing `apps/ui/src/components/map/geocoding.ts` (Google + Nominatim + postal
fallbacks) behind the provider interface. The existing PII-mask guard and in-memory/localStorage caching are
retained.

### Backend geo-resolver

The backend does **not** autocomplete (no interactive typing); it resolves a composite address string to
coordinates:

```ts
interface GeoResolver { resolve(query: string): Promise<{ lat: number; lng: number } | null>; }
```

- **GoogleGeocodingResolver** — used when `GOOGLE_GEOCODING_API_KEY` is set (server-side Geocoding REST API).
- **PhotonResolver** — fallback; first Photon result.

## Data flow

### UI create / edit (`apps/ui/src/pages/profile-form-page.tsx`)

1. `generateUiSchema` detects `"location": "primary"` on a field → assigns
   `ui:widget: 'location-autocomplete'`.
2. The new `LocationAutocompleteWidget` (registered in the `widgets` map in `schema-form.tsx`) renders a
   shadcn combobox driven by the active `GeoProvider`.
3. On suggestion select, the widget sets its field value and reports `{ lat, lng }` via RJSF
   `formContext.onLocationResolved(coords)`.
4. `profile-form-page` holds the reported coords in state and attaches them as **top-level**
   `item_latitude` / `item_longitude` on the create/update payload — never inside `item_state`
   (profile schemas use `additionalProperties: false`).
5. **No-pick fallback:** if the user typed but never selected a suggestion (or no provider is available), on
   submit the page builds the composite query (primary field value + any `true` field values) and geocodes it
   one-shot via the same provider. This replaces `extractAndGeocode`.

### API create (`apps/api/src/routes/v1/item/create_item.ts`)

In `create_item_handler`, **before** `createItemInternal`:

1. If `body.item_latitude` and `body.item_longitude` are both null:
   a. Load the network config via `getNetworkConfigs()` and find the `location`-marked fields for
      `body.item_domain`.
   b. Build the composite query from the corresponding `body.item_state` values.
   c. Resolve via `GoogleGeocodingResolver` (if `GOOGLE_GEOCODING_API_KEY`) else `PhotonResolver`.
   d. Set the resolved coords on the insert.
2. If coords are already present (UI path already produced precise coords), trust them and skip server
   geocoding.
3. **Best-effort:** any geocoding failure is caught, logged with `request.log.warn`, and creation proceeds
   with null coordinates. Geocoding never blocks item creation.

## Shared marker extraction

Replace the hardcoded lists in `apps/ui/src/lib/item-utils.ts` with a marker-driven helper, e.g.:

```ts
// Given the item/form data and the resolved location-marked field names
// (primary first, then secondary), produce the composite geocode query string.
function buildGeoQuery(data: Record<string, unknown>, markedFields: string[]): string | null
```

A small parser reads a profile schema's properties and returns
`{ primary: string | null; secondary: string[] }`. Both the frontend (form + map) and the backend use the
same extraction semantics (backend has its own copy in the API package, mirroring the existing duplication
pattern noted in `network_workflow.ts`).

## Call sites to migrate

- `apps/ui/src/pages/profile-form-page.tsx` — replace `extractAndGeocode` with widget-reported coords +
  composite no-pick fallback.
- `apps/ui/src/components/map/map-container.tsx` — its runtime fallback geocoding currently uses
  `extractAddressFromForm` / `extractPincodeFromForm`; switch to the marker-based extractor, reading the
  marked fields from each item's network config.
- `apps/ui/src/lib/item-utils.ts` — delete `directLocationFields` / locality / region / pincode lists and
  `extractAddressFromForm` / `extractPincodeFromForm`; provide `buildGeoQuery` + schema marker parser.

## Config / environment (paired changes)

Per CLAUDE.md, env vars change in two places together:

- `packages/config/src/secrets.ts`: add `GOOGLE_GEOCODING_API_KEY` (optional — reuse the client key value or a
  separate unrestricted/IP-restricted key) and `PHOTON_URL` (optional, default public endpoint).
- `turbo.json` `globalPassThroughEnv`: add `GOOGLE_GEOCODING_API_KEY`, `PHOTON_URL`.
- Frontend: `VITE_GOOGLE_MAPS_API_KEY` already exists; add optional `VITE_PHOTON_URL`.

## Error handling

- Provider/network errors during autocomplete → return `[]` suggestions; the form stays submittable.
- One-shot geocode failure → `null` coords; the item is still saved (without coordinates).
- Backend geocoding wrapped in try/catch → `request.log.warn`, proceed with null.
- PII-mask guard (`looksLikePIIMask`) retained on all geocode inputs.

## Testing

- **Unit (UI):** marker parser (primary + secondary extraction), `buildGeoQuery` composition, Photon response
  parsing, Google suggestion/resolve mapping, provider selection by key presence.
- **Unit (API):** marker extraction from network config, "skip when coords already present" logic, Photon
  resolver parsing.
- **Integration (API):** `POST /api/v1/item/create`
  - without coords + a marked field → server fills lat/lng (Photon mocked);
  - with coords → coords untouched;
  - geocoding error → item created with null coords, warn logged.
- **Manual:** purple_dot `seeker` form on `:3000` — type an address, pick a suggestion, confirm coords are
  stored; then create the same profile via the API and confirm coords are populated server-side.

## Operational notes

- Switching the locally-running network (orange ↔ purple) requires clearing the on-disk schema cache
  (`$TMPDIR/dpg-network-schema-cache/`) and flushing Redis; otherwise a stale network config is served and the
  UI renders blank. (See the prior incident in this branch's setup.)

## Open questions

None outstanding. Marker vocabulary, fallback provider (Photon), backend trigger (only-when-absent), and
no-auto-fill were all confirmed during design.
