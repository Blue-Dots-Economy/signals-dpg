# Config-driven Geotagging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each network declare its address field(s) in `network.json` via a `location` marker, geocode that field (Google Places autocomplete in the UI, Photon fallback, and server-side geocoding for API-created items), and store lat/lng on the item.

**Architecture:** Pure shared logic (marker parsing + composite query building) lives in `@dpg/schemas` and is consumed by both UI and API. The UI adds a provider abstraction (Google Places Data API or Photon) behind one autocomplete widget; the API adds a server-side geo-resolver (Google Geocoding REST or Photon) invoked in the create-item path only when coordinates are absent.

**Tech Stack:** TypeScript (ESM), Zod, Drizzle, Fastify, React 19 + RJSF (`@rjsf/shadcn`), Vitest (packages/schemas + apps/api), Google Maps Places/Geocoding, Photon (OpenStreetMap).

---

## Decisions baked in (from the design)

- Marker: `"location": "primary"` (exactly one field per profile schema) + `"location": true` (zero or more secondary fields). No per-field roles, no auto-fill.
- Free fallback: **Photon** (`https://photon.komoot.io`), no API key.
- Backend geocodes **only when** `item_latitude`/`item_longitude` are both absent (trusts UI-supplied coords).
- Heuristic field-selection lists in `item-utils.ts` are **deleted**; selection is marker-driven.
- Shared pure logic goes in `@dpg/schemas` (has tests; no test harness added to `apps/ui`).
- Migrate all four networks: `orange_dot`, `purple_dot`, `yellow_dot`, `blue_dot`.

## File structure

**Created**
- `packages/schemas/src/location_fields.ts` — `parseLocationFields`, `buildGeoQuery`, types.
- `packages/schemas/src/__tests__/location_fields.test.ts` — unit tests.
- `apps/ui/src/lib/geo/types.ts` — `GeoSuggestion`, `GeoProvider`.
- `apps/ui/src/lib/geo/photon.ts` — `parsePhotonFeatures`, `createPhotonProvider`.
- `apps/ui/src/lib/geo/google-places.ts` — `createGooglePlacesProvider`.
- `apps/ui/src/lib/geo/provider.ts` — `getGeoProvider`.
- `apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx` — RJSF widget.
- `apps/api/src/services/geocoding/geo_resolver.ts` — `resolveCoordinates`, pure parsers.
- `apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts` — unit tests.

**Modified**
- `packages/schemas/src/index.ts` — re-export location_fields.
- `examples/schemas/{orange_dot,purple_dot,yellow_dot,blue_dot}/network.json` — add markers.
- `apps/ui/src/components/forms/schema-form.tsx` — widget registration, `ui:widget` for primary, strip `location` keyword, `formContext` passthrough.
- `apps/ui/src/pages/profile-form-page.tsx` — widget coords + composite fallback (replaces `extractAndGeocode`).
- `apps/ui/src/components/map/map-container.tsx` — marker-based extractor.
- `apps/ui/src/lib/item-utils.ts` — delete heuristic, keep nothing geo-name-based.
- `packages/config/src/secrets.ts` — `GeocodingSecretsSchema`.
- `apps/api/src/env.ts` — parse `geocoding` group.
- `apps/api/src/config.ts` — `geocodingConfig`.
- `turbo.json` — passthrough `GOOGLE_GEOCODING_API_KEY`, `PHOTON_URL`.
- `apps/api/src/routes/v1/item/create_item.ts` — backend geocode hook.

---

## Task 1: Shared marker parser + composite query builder (`@dpg/schemas`)

**Files:**
- Create: `packages/schemas/src/location_fields.ts`
- Create: `packages/schemas/src/__tests__/location_fields.test.ts`
- Modify: `packages/schemas/src/index.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/schemas/src/__tests__/location_fields.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseLocationFields, buildGeoQuery } from '../location_fields';

const seekerSchema = {
  type: 'object',
  properties: {
    beneficiary_name: { type: 'string' },
    address: { type: 'string', location: 'primary' },
    service_city: { type: 'string', location: true },
    state: { type: 'string', location: true },
    pincode: { type: 'string', location: true },
  },
};

const touristSchema = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    location: { type: 'string', location: 'primary' },
  },
};

const noMarkerSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, city: { type: 'string' } },
};

describe('parseLocationFields', () => {
  it('returns the primary field and secondary fields in declaration order', () => {
    expect(parseLocationFields(seekerSchema)).toEqual({
      primary: 'address',
      secondary: ['service_city', 'state', 'pincode'],
    });
  });

  it('handles a single primary field with no secondaries', () => {
    expect(parseLocationFields(touristSchema)).toEqual({
      primary: 'location',
      secondary: [],
    });
  });

  it('returns null primary when no field is marked', () => {
    expect(parseLocationFields(noMarkerSchema)).toEqual({
      primary: null,
      secondary: [],
    });
  });
});

describe('buildGeoQuery', () => {
  it('joins primary then secondary values present in the data', () => {
    const data = {
      address: '12 MG Road',
      service_city: 'Bengaluru',
      state: 'Karnataka',
      pincode: '560001',
    };
    expect(buildGeoQuery(data, parseLocationFields(seekerSchema))).toBe(
      '12 MG Road, Bengaluru, Karnataka, 560001'
    );
  });

  it('skips empty/missing values', () => {
    const data = { address: 'Udupi', service_city: '', pincode: '576101' };
    expect(buildGeoQuery(data, parseLocationFields(seekerSchema))).toBe(
      'Udupi, 576101'
    );
  });

  it('returns null when no marked values are present', () => {
    expect(buildGeoQuery({}, parseLocationFields(seekerSchema))).toBeNull();
  });

  it('returns null when there is no primary field', () => {
    expect(buildGeoQuery({ city: 'X' }, parseLocationFields(noMarkerSchema))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/location_fields.test.ts`
Expected: FAIL — cannot resolve `../location_fields`.

- [ ] **Step 3: Write the implementation**

Create `packages/schemas/src/location_fields.ts`:

```ts
/**
 * Marker-driven location-field selection for geocoding.
 *
 * A profile JSON-Schema property may carry a `location` keyword:
 *   - `"location": "primary"` — exactly one field; the autocomplete/geocode
 *     anchor that yields lat/lng and leads the composite query.
 *   - `"location": true`      — secondary address fields appended to the
 *     composite geocode query (fallback + backend paths).
 *
 * Shared by the UI (form + map) and the API (server-side geocode) so the
 * selection semantics never drift between client and server.
 */
export interface LocationFields {
  primary: string | null;
  secondary: string[];
}

type JsonSchemaProperty = { location?: unknown };

export function parseLocationFields(
  itemSchema: Record<string, unknown> | null | undefined
): LocationFields {
  const result: LocationFields = { primary: null, secondary: [] };
  const properties = (itemSchema?.properties ?? {}) as Record<string, JsonSchemaProperty>;

  for (const [name, prop] of Object.entries(properties)) {
    const marker = prop?.location;
    if (marker === 'primary') {
      // First primary wins; ignore accidental duplicates.
      if (result.primary === null) result.primary = name;
    } else if (marker === true) {
      result.secondary.push(name);
    }
  }

  return result;
}

/**
 * Builds a single geocode query string from the marked fields' values in
 * `data`: primary first, then secondaries in declaration order. Empty/missing
 * values are skipped. Returns null when there is no primary field or no usable
 * value.
 */
export function buildGeoQuery(
  data: Record<string, unknown>,
  fields: LocationFields
): string | null {
  if (!fields.primary) return null;

  const ordered = [fields.primary, ...fields.secondary];
  const parts = ordered
    .map((name) => data[name])
    .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
    .map((v) => v.trim());

  return parts.length > 0 ? parts.join(', ') : null;
}
```

- [ ] **Step 4: Re-export from the package index**

In `packages/schemas/src/index.ts`, add alongside the other re-exports:

```ts
export {
  parseLocationFields,
  buildGeoQuery,
  type LocationFields,
} from './location_fields';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @dpg/schemas exec vitest run src/__tests__/location_fields.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 6: Run Codacy on edited files**

Run Codacy CLI analyze on `packages/schemas/src/location_fields.ts` and `packages/schemas/src/index.ts` (per CLAUDE.md; skip complexity/coverage).

- [ ] **Step 7: Commit**

```bash
git add packages/schemas/src/location_fields.ts packages/schemas/src/__tests__/location_fields.test.ts packages/schemas/src/index.ts
git commit -m "feat(schemas): marker-driven location field parsing + composite geo query"
```

---

## Task 2: Add `location` markers to all four network.json files

**Files:**
- Modify: `examples/schemas/orange_dot/network.json`
- Modify: `examples/schemas/purple_dot/network.json`
- Modify: `examples/schemas/yellow_dot/network.json`
- Modify: `examples/schemas/blue_dot/network.json`
- Test: `packages/schemas/src/__tests__/example_network_configs.test.ts` (existing — add assertions)

Mark exactly one `"primary"` per profile schema; mark the remaining address fields `true`. Field names per network (confirmed):

- **orange_dot / tourist** → `location`: `"primary"`.
- **orange_dot / practitioner** → `area`: `"primary"`.
- **purple_dot / seeker** → `address`: `"primary"`; `service_city`, `district`, `state`, `pincode`: `true`.
- **purple_dot / provider** → `official_address`: `"primary"`; `district`, `state`, `pincode`: `true` (leave `service_cities` array untouched — it is multi-value, not a geocode anchor).
- **yellow_dot / student** → the address field is named `Location` → `"primary"`.
- **blue_dot / job_seeker** → `location`: `"primary"`.

- [ ] **Step 1: Inspect each network's profile properties**

Run:
```bash
for n in orange_dot purple_dot yellow_dot blue_dot; do
  echo "== $n =="
  python3 -c "import json;d=json.load(open('examples/schemas/$n/network.json'));[print(dom['id'], list((dom.get('item_schemas') or {}).get('profile_1.0',{}).get('properties',{}).keys())) for dom in d['domains']]"
done
```
Expected: prints each domain's profile field names; confirm the anchor names above exist (adjust if a name differs).

- [ ] **Step 2: Edit the JSON — add the marker keyword**

For each property identified above, add the `location` keyword as a sibling of `type`. Example (purple_dot seeker `address`):

```jsonc
"address": {
  "type": "string",
  "title": "Address",
  "location": "primary"
}
```
and for `service_city` / `state` / `district` / `pincode`:
```jsonc
"service_city": { "type": "string", "title": "City", "location": true }
```
Edit the real files in place (keep all existing keywords; only add `"location"`).

- [ ] **Step 3: Add assertions to the existing example-config test**

In `packages/schemas/src/__tests__/example_network_configs.test.ts`, append a block (adapt to the file's existing import of the example configs):

```ts
import { parseLocationFields } from '../location_fields';

describe('example network configs declare a primary location field', () => {
  const cases = [
    ['orange_dot', 'tourist'],
    ['orange_dot', 'practitioner'],
    ['purple_dot', 'seeker'],
    ['purple_dot', 'provider'],
    ['yellow_dot', 'student'],
    ['blue_dot', 'job_seeker'],
  ] as const;

  it.each(cases)('%s/%s has exactly one primary location field', (network, domain) => {
    const config = loadExampleConfig(network); // reuse the file's existing loader
    const dom = config.domains.find((d: { id: string }) => d.id === domain);
    const schema = dom.item_schemas['profile_1.0'];
    const fields = parseLocationFields(schema);
    expect(fields.primary).not.toBeNull();
  });
});
```
(If the test file has no reusable loader, read each `network.json` with `fs.readFileSync` + `JSON.parse` inside the test.)

- [ ] **Step 4: Run the schemas test suite (parsing + new assertions)**

Run: `pnpm --filter @dpg/schemas test`
Expected: PASS — configs still parse under `NetworkConfigSchema` (the `location` keyword survives `z.unknown()`), and every listed domain has a primary.

- [ ] **Step 5: Regenerate + verify the deploy schema bundle is unaffected**

Run: `pnpm schema:bundle:check`
Expected: PASS (no DB schema change; this guards against accidental drift).

- [ ] **Step 6: Commit**

```bash
git add examples/schemas/*/network.json packages/schemas/src/__tests__/example_network_configs.test.ts
git commit -m "feat(networks): declare primary/secondary location fields in network.json"
```

---

## Task 3: Geo provider interface + Photon provider (UI)

**Files:**
- Create: `apps/ui/src/lib/geo/types.ts`
- Create: `apps/ui/src/lib/geo/photon.ts`

No runnable UI unit harness exists; correctness of the pure parser is mirrored and tested server-side in Task 9. Verify here with typecheck.

- [ ] **Step 1: Define the provider contract**

Create `apps/ui/src/lib/geo/types.ts`:

```ts
export interface GeoSuggestion {
  /** Human-readable label shown in the dropdown. */
  label: string;
  lat: number;
  lng: number;
}

export interface GeoProvider {
  /** Returns ranked suggestions for a free-text query (empty array on error). */
  suggest(query: string, signal?: AbortSignal): Promise<GeoSuggestion[]>;
}
```

- [ ] **Step 2: Implement the Photon provider + pure parser**

Create `apps/ui/src/lib/geo/photon.ts`:

```ts
import type { GeoProvider, GeoSuggestion } from './types';

const DEFAULT_PHOTON_URL = 'https://photon.komoot.io';

interface PhotonFeature {
  geometry?: { coordinates?: [number, number] }; // [lng, lat]
  properties?: {
    name?: string;
    city?: string;
    state?: string;
    postcode?: string;
    country?: string;
  };
}

/** Pure: maps a Photon FeatureCollection JSON into suggestions. Exported for testing. */
export function parsePhotonFeatures(json: unknown): GeoSuggestion[] {
  const features = (json as { features?: PhotonFeature[] })?.features ?? [];
  const out: GeoSuggestion[] = [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (!coords || coords.length !== 2) continue;
    const [lng, lat] = coords;
    if (typeof lat !== 'number' || typeof lng !== 'number') continue;
    const p = f.properties ?? {};
    const label = [p.name, p.city, p.state, p.postcode, p.country]
      .filter((s): s is string => Boolean(s && s.trim()))
      .join(', ');
    out.push({ label: label || `${lat}, ${lng}`, lat, lng });
  }
  return out;
}

export function createPhotonProvider(baseUrl = DEFAULT_PHOTON_URL): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        const url = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(q)}&limit=5`;
        const res = await fetch(url, { signal });
        if (!res.ok) return [];
        return parsePhotonFeatures(await res.json());
      } catch {
        return [];
      }
    },
  };
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/lib/geo/types.ts apps/ui/src/lib/geo/photon.ts
git commit -m "feat(ui): geo provider interface + Photon provider"
```

---

## Task 4: Google Places provider + provider selector (UI)

**Files:**
- Create: `apps/ui/src/lib/geo/google-places.ts`
- Create: `apps/ui/src/lib/geo/provider.ts`

- [ ] **Step 1: Implement the Google Places provider**

Create `apps/ui/src/lib/geo/google-places.ts`. Uses the Places library loaded via `importLibrary`, the Autocomplete Data API for predictions, and `fetchFields(['location'])` to resolve coordinates:

```ts
import type { GeoProvider, GeoSuggestion } from './types';

type GoogleNS = {
  maps: {
    importLibrary: (name: string) => Promise<Record<string, unknown>>;
  };
};

let scriptPromise: Promise<void> | null = null;

function loadMapsApi(apiKey: string): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if ((window as unknown as { google?: GoogleNS }).google?.maps?.importLibrary) {
    return Promise.resolve();
  }
  if (scriptPromise) return scriptPromise;

  scriptPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      'script[data-dpg-google-maps="true"]'
    );
    (window as unknown as { __dpgGoogleMapsInit?: () => void }).__dpgGoogleMapsInit = () => resolve();
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('maps load failed')), { once: true });
      return;
    }
    const script = document.createElement('script');
    const url = new URL('https://maps.googleapis.com/maps/api/js');
    url.searchParams.set('key', apiKey);
    url.searchParams.set('libraries', 'places');
    url.searchParams.set('callback', '__dpgGoogleMapsInit');
    url.searchParams.set('loading', 'async');
    url.searchParams.set('v', 'weekly');
    script.src = url.toString();
    script.async = true;
    script.defer = true;
    script.dataset.dpgGoogleMaps = 'true';
    script.onerror = () => reject(new Error('maps load failed'));
    document.head.appendChild(script);
  });
  return scriptPromise;
}

export function createGooglePlacesProvider(apiKey: string): GeoProvider {
  return {
    async suggest(query, signal) {
      const q = query.trim();
      if (!q) return [];
      try {
        await loadMapsApi(apiKey);
        const places = (await (
          window as unknown as { google: GoogleNS }
        ).google.maps.importLibrary('places')) as {
          AutocompleteSessionToken: new () => object;
          AutocompleteSuggestion: {
            fetchAutocompleteSuggestions: (req: object) => Promise<{
              suggestions: Array<{
                placePrediction: {
                  text: { toString: () => string };
                  toPlace: () => {
                    fetchFields: (req: { fields: string[] }) => Promise<void>;
                    location?: { lat: () => number; lng: () => number };
                  };
                };
              }>;
            }>;
          };
        };

        const token = new places.AutocompleteSessionToken();
        const { suggestions } = await places.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input: q,
          sessionToken: token,
        });

        const top = suggestions.slice(0, 5);
        const resolved = await Promise.all(
          top.map(async (s) => {
            if (signal?.aborted) return null;
            const place = s.placePrediction.toPlace();
            await place.fetchFields({ fields: ['location'] });
            const loc = place.location;
            if (!loc) return null;
            return {
              label: s.placePrediction.text.toString(),
              lat: loc.lat(),
              lng: loc.lng(),
            } satisfies GeoSuggestion;
          })
        );
        return resolved.filter((x): x is GeoSuggestion => x !== null);
      } catch {
        return [];
      }
    },
  };
}
```

- [ ] **Step 2: Implement the provider selector**

Create `apps/ui/src/lib/geo/provider.ts`:

```ts
import { getRuntimeEnv } from '@/lib/runtime-env';
import type { GeoProvider } from './types';
import { createPhotonProvider } from './photon';
import { createGooglePlacesProvider } from './google-places';

let cached: GeoProvider | null = null;

/**
 * Active geo provider: Google Places when a maps key is configured, otherwise
 * the key-less Photon fallback.
 */
export function getGeoProvider(): GeoProvider {
  if (cached) return cached;
  const apiKey = getRuntimeEnv('VITE_GOOGLE_MAPS_API_KEY');
  const photonUrl = getRuntimeEnv('VITE_PHOTON_URL') as string | undefined;
  cached = apiKey
    ? createGooglePlacesProvider(apiKey)
    : createPhotonProvider(photonUrl || undefined);
  return cached;
}
```

- [ ] **Step 3: Declare the new VITE var type**

In `apps/ui/src/vite-env.d.ts`, add `readonly VITE_PHOTON_URL?: string;` to the `ImportMetaEnv` interface (alongside `VITE_GOOGLE_MAPS_API_KEY`).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/geo/google-places.ts apps/ui/src/lib/geo/provider.ts apps/ui/src/vite-env.d.ts
git commit -m "feat(ui): Google Places provider + key-based provider selection"
```

---

## Task 5: Location autocomplete widget + form wiring (UI)

**Files:**
- Create: `apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx`
- Modify: `apps/ui/src/components/forms/schema-form.tsx`

- [ ] **Step 1: Build the widget**

Create `apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx`. Debounced combobox; on select sets the field value and reports coords via `formContext.onLocationResolved`:

```tsx
import * as React from 'react';
import type { WidgetProps } from '@rjsf/utils';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { getGeoProvider } from '@/lib/geo/provider';
import type { GeoSuggestion } from '@/lib/geo/types';

interface LocationFormContext {
  onLocationResolved?: (coords: { lat: number; lng: number } | null) => void;
}

export function LocationAutocompleteWidget({
  id,
  value,
  disabled,
  readonly,
  onChange,
  rawErrors,
  formContext,
}: WidgetProps) {
  const ctx = (formContext ?? {}) as LocationFormContext;
  const [text, setText] = React.useState<string>((value as string) ?? '');
  const [suggestions, setSuggestions] = React.useState<GeoSuggestion[]>([]);
  const [open, setOpen] = React.useState(false);
  const provider = React.useMemo(() => getGeoProvider(), []);

  React.useEffect(() => {
    const q = text.trim();
    if (q.length < 3) {
      setSuggestions([]);
      return;
    }
    const controller = new AbortController();
    const handle = window.setTimeout(async () => {
      const results = await provider.suggest(q, controller.signal);
      if (!controller.signal.aborted) {
        setSuggestions(results);
        setOpen(results.length > 0);
      }
    }, 300);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [text, provider]);

  function choose(s: GeoSuggestion) {
    setText(s.label);
    onChange(s.label);
    ctx.onLocationResolved?.({ lat: s.lat, lng: s.lng });
    setOpen(false);
    setSuggestions([]);
  }

  return (
    <div className="relative space-y-2">
      <Input
        id={id}
        value={text}
        disabled={disabled || readonly}
        autoComplete="off"
        className={cn(rawErrors && rawErrors.length > 0 && 'border-destructive')}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
          // Typed manually => previous precise coords no longer valid.
          ctx.onLocationResolved?.(null);
        }}
        onFocus={() => setOpen(suggestions.length > 0)}
      />
      {open && suggestions.length > 0 && (
        <ul className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
          {suggestions.map((s, i) => (
            <li key={`${s.lat},${s.lng},${i}`}>
              <button
                type="button"
                className="block w-full px-3 py-2 text-left text-sm hover:bg-accent"
                onClick={() => choose(s)}
              >
                {s.label}
              </button>
            </li>
          ))}
        </ul>
      )}
      {rawErrors && rawErrors.length > 0 && (
        <p className="text-sm text-destructive">{rawErrors.join(', ')}</p>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Register the widget + drive it from the marker, and strip the keyword**

In `apps/ui/src/components/forms/schema-form.tsx`:

a. Import the widget and add it to the registry:
```ts
import { LocationAutocompleteWidget } from './custom-widgets/location-autocomplete-widget';

const widgets: RegistryWidgetsType = {
  date: DatePickerWidget,
  'location-autocomplete': LocationAutocompleteWidget,
};
```

b. In `generateUiSchema`, inside the `for (const [key, prop] of Object.entries(schema.properties ?? {}))` loop, after the existing `typed` cast, add:
```ts
if ((typed as { location?: unknown }).location === 'primary') {
  uiSchema[key] = { ...(uiSchema[key] as object), 'ui:widget': 'location-autocomplete' };
}
```

c. In `normalizeSchemaForRjsf`, strip the custom `location` keyword so the ajv8 validator never sees it. In the per-key loop, skip it:
```ts
for (const [key, value] of Object.entries(schema as Record<string, unknown>)) {
  if (key === 'location') continue; // custom marker — consumed by uiSchema, not JSON Schema
  result[key] = normalizeSchemaForRjsf(value as RJSFSchema, root);
}
```

d. Add a `formContext` prop to `SchemaFormProps` and pass it to `<Form>`:
```ts
// in SchemaFormProps:
formContext?: Record<string, unknown>;
// in the component signature destructure: formContext,
// on <Form ...>: formContext={formContext}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/ui/src/components/forms/custom-widgets/location-autocomplete-widget.tsx apps/ui/src/components/forms/schema-form.tsx
git commit -m "feat(ui): location autocomplete widget driven by the primary marker"
```

---

## Task 6: Profile form integration — coords + composite fallback (UI)

**Files:**
- Modify: `apps/ui/src/pages/profile-form-page.tsx`

Replace the `extractAndGeocode` call with (a) widget-reported coords and (b) a submit-time composite fallback via the provider.

- [ ] **Step 1: Add coords state + provider fallback imports**

Near the top of the component, add imports:
```ts
import { parseLocationFields, buildGeoQuery } from '@dpg/schemas';
import { getGeoProvider } from '@/lib/geo/provider';
```
Remove the `extractAndGeocode` import (line ~33).

Inside the component body, add state:
```ts
const [resolvedCoords, setResolvedCoords] = React.useState<{ lat: number; lng: number } | null>(null);
```

- [ ] **Step 2: Pass `formContext` into the form**

Where `<SchemaForm ... />` is rendered, add:
```tsx
formContext={{ onLocationResolved: setResolvedCoords }}
```

- [ ] **Step 3: Replace geocoding in `handleSubmit`**

In `handleSubmit`, replace the line
```ts
const { coordinates } = await extractAndGeocode(data, selectedDomain);
```
with:
```ts
let coordinates = resolvedCoords;
if (!coordinates && profileSchema) {
  // No suggestion picked (typed free text or no provider) — geocode the
  // composite of the marked fields one-shot.
  const fields = parseLocationFields(profileSchema as Record<string, unknown>);
  const query = buildGeoQuery(data, fields);
  if (query) {
    const [best] = await getGeoProvider().suggest(query);
    if (best) coordinates = { lat: best.lat, lng: best.lng };
  }
}
```
The existing `if (coordinates) { ...item_latitude/longitude... }` blocks for both create and update continue to work unchanged.

- [ ] **Step 4: Verify `profileSchema` is the in-scope schema variable**

Run: `grep -n "profileSchema" apps/ui/src/pages/profile-form-page.tsx`
Expected: the variable holding the active domain's JSON schema exists (used to render the form). If the local name differs, use that name in Step 3.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: PASS — `extractAndGeocode` no longer referenced here.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/pages/profile-form-page.tsx
git commit -m "feat(ui): profile form uses widget coords + composite geocode fallback"
```

---

## Task 7: Map fallback migration + delete heuristic (UI)

**Files:**
- Modify: `apps/ui/src/components/map/map-container.tsx`
- Modify: `apps/ui/src/lib/item-utils.ts`

The map view geocodes items lacking stored coords. Switch it to the marker-based query. Each item carries `item_network`/`item_domain`; resolve its profile schema from the loaded network config(s) available in the map component, then `parseLocationFields` + `buildGeoQuery`.

- [ ] **Step 1: Inspect how the map gets schemas per item**

Run: `grep -n "schema\|networkConfig\|item_domain\|props" apps/ui/src/components/map/map-container.tsx | head -40`
Expected: identify the prop/source that exposes the per-domain profile schema (the file already takes a `schema` and a `findTitleField(schema)`; confirm whether it has the network config for multi-domain "All" view).

- [ ] **Step 2: Replace the heuristic fallback block**

In `map-container.tsx`, replace the pincode + address heuristic blocks (the `extractPincodeFromForm` / `extractAddressFromForm` / `geocode*` sequence, ~lines 125-160) with:

```ts
// Fallback: geocode the marked composite query for this item's schema.
if (lat === null || lng === null) {
  const itemSchema = schemaForItem(item); // resolve the profile schema for item's domain
  const fields = parseLocationFields(itemSchema as Record<string, unknown>);
  const query = buildGeoQuery(item.data, fields);
  if (query) {
    const [best] = await getGeoProvider().suggest(query);
    if (best) {
      lat = best.lat;
      lng = best.lng;
      precision = 'geocoded_full_address';
      geocodedFrom = fields.primary ?? 'location';
    }
  }
}
```
Add imports:
```ts
import { parseLocationFields, buildGeoQuery } from '@dpg/schemas';
import { getGeoProvider } from '@/lib/geo/provider';
```
Remove the now-unused imports of `extractPincodeFromForm`, `extractAddressFromForm`, `geocodePincode`, `geocodeAddress`, `geocodeAddressWithGoogle` from this file. Implement `schemaForItem(item)` using whatever schema source Step 1 surfaced (for a single-schema view, it is just the `schema` prop).

- [ ] **Step 3: Delete the heuristic from item-utils**

In `apps/ui/src/lib/item-utils.ts`, delete `domainPincodeFields`, `directLocationFields`, `localityFields`, `regionFields`, `countryFields`, `pincodeFields`, `addressLikeTokens`/token lists, and the functions `extractPincodeFromForm`, `extractAddressFromForm`, `extractAndGeocode`, `findAddressInNestedObject`, `findPincodeRecursively`, `getStringField*`, `hasToken`, `getFieldValue`. Keep `normalizeFieldName` only if other modules still import it (check next step).

- [ ] **Step 4: Confirm no dangling references**

Run:
```bash
grep -rn "extractAndGeocode\|extractAddressFromForm\|extractPincodeFromForm" apps/ui/src
grep -rn "normalizeFieldName" apps/ui/src
```
Expected: first grep returns nothing. If `normalizeFieldName` has no remaining importers, delete it too; if it does, leave it.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/components/map/map-container.tsx apps/ui/src/lib/item-utils.ts
git commit -m "refactor(ui): marker-based map geocoding; remove hardcoded field heuristics"
```

---

## Task 8: Backend geocoding env + config

**Files:**
- Modify: `packages/config/src/secrets.ts`
- Modify: `apps/api/src/env.ts`
- Modify: `apps/api/src/config.ts`
- Modify: `turbo.json`

- [ ] **Step 1: Add the secrets schema**

In `packages/config/src/secrets.ts`, add:
```ts
export const GeocodingSecretsSchema = z.object({
  GOOGLE_GEOCODING_API_KEY: z.string().optional(),
  PHOTON_URL: z.string().optional(),
});
```

- [ ] **Step 2: Parse it in env loader**

In `apps/api/src/env.ts`: import `GeocodingSecretsSchema`, add
```ts
const geocoding = GeocodingSecretsSchema.parse(process.env);
```
and include `geocoding` in the returned object.

- [ ] **Step 3: Expose config**

In `apps/api/src/config.ts`: add `geocoding` to the `loadEnv()` destructure, then:
```ts
export const geocodingConfig = {
  google_api_key: geocoding.GOOGLE_GEOCODING_API_KEY,
  photon_url: geocoding.PHOTON_URL ?? 'https://photon.komoot.io',
};
```

- [ ] **Step 4: Add turbo passthrough**

In `turbo.json` `globalPassThroughEnv`, add `"GOOGLE_GEOCODING_API_KEY"` and `"PHOTON_URL"` (keep alphabetical-ish ordering of the array).

- [ ] **Step 5: Typecheck the API**

Run: `pnpm --filter api exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/config/src/secrets.ts apps/api/src/env.ts apps/api/src/config.ts turbo.json
git commit -m "feat(config): geocoding env (GOOGLE_GEOCODING_API_KEY, PHOTON_URL)"
```

---

## Task 9: Backend geo-resolver

**Files:**
- Create: `apps/api/src/services/geocoding/geo_resolver.ts`
- Create: `apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parsePhotonFeatures, parseGoogleGeocode } from '../geo_resolver';

describe('parsePhotonFeatures', () => {
  it('returns lat/lng from the first feature ([lng,lat] order)', () => {
    const json = { features: [{ geometry: { coordinates: [77.59, 12.97] } }] };
    expect(parsePhotonFeatures(json)).toEqual({ lat: 12.97, lng: 77.59 });
  });
  it('returns null when no features', () => {
    expect(parsePhotonFeatures({ features: [] })).toBeNull();
  });
});

describe('parseGoogleGeocode', () => {
  it('returns lat/lng from the first result geometry', () => {
    const json = {
      status: 'OK',
      results: [{ geometry: { location: { lat: 12.97, lng: 77.59 } } }],
    };
    expect(parseGoogleGeocode(json)).toEqual({ lat: 12.97, lng: 77.59 });
  });
  it('returns null on ZERO_RESULTS', () => {
    expect(parseGoogleGeocode({ status: 'ZERO_RESULTS', results: [] })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/geo_resolver.test.ts`
Expected: FAIL — cannot resolve `../geo_resolver`.

- [ ] **Step 3: Implement the resolver**

Create `apps/api/src/services/geocoding/geo_resolver.ts`:

```ts
import { geocodingConfig } from '@/config';

export interface Coordinates {
  lat: number;
  lng: number;
}

/** Pure: first valid Photon feature -> coords. Exported for testing. */
export function parsePhotonFeatures(json: unknown): Coordinates | null {
  const features =
    (json as { features?: Array<{ geometry?: { coordinates?: [number, number] } }> })
      ?.features ?? [];
  for (const f of features) {
    const coords = f.geometry?.coordinates;
    if (coords && coords.length === 2) {
      const [lng, lat] = coords;
      if (typeof lat === 'number' && typeof lng === 'number') return { lat, lng };
    }
  }
  return null;
}

/** Pure: first Google geocode result -> coords. Exported for testing. */
export function parseGoogleGeocode(json: unknown): Coordinates | null {
  const data = json as {
    status?: string;
    results?: Array<{ geometry?: { location?: { lat: number; lng: number } } }>;
  };
  if (data?.status !== 'OK') return null;
  const loc = data.results?.[0]?.geometry?.location;
  if (loc && typeof loc.lat === 'number' && typeof loc.lng === 'number') {
    return { lat: loc.lat, lng: loc.lng };
  }
  return null;
}

async function resolveWithGoogle(query: string, apiKey: string): Promise<Coordinates | null> {
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', query);
  url.searchParams.set('key', apiKey);
  const res = await fetch(url);
  if (!res.ok) return null;
  return parseGoogleGeocode(await res.json());
}

async function resolveWithPhoton(query: string, baseUrl: string): Promise<Coordinates | null> {
  const url = `${baseUrl.replace(/\/$/, '')}/api?q=${encodeURIComponent(query)}&limit=1`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return parsePhotonFeatures(await res.json());
}

/**
 * Server-side resolve of a composite address string to coordinates.
 * Google Geocoding when a key is configured, else Photon. Returns null on any
 * failure — callers must treat geocoding as best-effort.
 */
export async function resolveCoordinates(query: string): Promise<Coordinates | null> {
  const q = query.trim();
  if (!q) return null;
  try {
    if (geocodingConfig.google_api_key) {
      return await resolveWithGoogle(q, geocodingConfig.google_api_key);
    }
    return await resolveWithPhoton(q, geocodingConfig.photon_url);
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/services/geocoding/__tests__/geo_resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Run Codacy on edited files**

Analyze `apps/api/src/services/geocoding/geo_resolver.ts` (skip complexity/coverage).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/geocoding/geo_resolver.ts apps/api/src/services/geocoding/__tests__/geo_resolver.test.ts
git commit -m "feat(api): server-side geo resolver (Google Geocoding + Photon)"
```

---

## Task 10: Backend create-item geocode hook

**Files:**
- Modify: `apps/api/src/routes/v1/item/create_item.ts`
- Test: `apps/api/src/routes/v1/item/__tests__/create_item.test.ts` (create if absent)

- [ ] **Step 1: Write the failing unit test for the "fill when absent" helper**

We isolate the decision logic into a small exported helper so it is unit-testable without a DB. Create `apps/api/src/routes/v1/item/__tests__/create_item.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { resolveItemCoordinates } from '../geotag_item';

describe('resolveItemCoordinates', () => {
  it('returns provided coords unchanged when both present', async () => {
    const out = await resolveItemCoordinates({
      lat: 1, lng: 2, itemState: { address: 'X' }, itemSchema: {},
      resolve: vi.fn(),
    });
    expect(out).toEqual({ lat: 1, lng: 2 });
  });

  it('geocodes the composite query when coords absent', async () => {
    const resolve = vi.fn().mockResolvedValue({ lat: 10, lng: 20 });
    const out = await resolveItemCoordinates({
      lat: null, lng: null,
      itemState: { address: 'Udupi', pincode: '576101' },
      itemSchema: {
        properties: {
          address: { type: 'string', location: 'primary' },
          pincode: { type: 'string', location: true },
        },
      },
      resolve,
    });
    expect(resolve).toHaveBeenCalledWith('Udupi, 576101');
    expect(out).toEqual({ lat: 10, lng: 20 });
  });

  it('returns nulls when geocoding fails', async () => {
    const out = await resolveItemCoordinates({
      lat: null, lng: null,
      itemState: { address: 'Nowhere' },
      itemSchema: { properties: { address: { type: 'string', location: 'primary' } } },
      resolve: vi.fn().mockResolvedValue(null),
    });
    expect(out).toEqual({ lat: null, lng: null });
  });

  it('returns nulls when no primary field is marked', async () => {
    const resolve = vi.fn();
    const out = await resolveItemCoordinates({
      lat: null, lng: null, itemState: { city: 'X' },
      itemSchema: { properties: { city: { type: 'string' } } },
      resolve,
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(out).toEqual({ lat: null, lng: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter api exec vitest run src/routes/v1/item/__tests__/create_item.test.ts`
Expected: FAIL — cannot resolve `../geotag_item`.

- [ ] **Step 3: Implement the helper**

Create `apps/api/src/routes/v1/item/geotag_item.ts`:

```ts
import { parseLocationFields, buildGeoQuery } from '@dpg/schemas';

interface ResolveArgs {
  lat: number | null;
  lng: number | null;
  itemState: Record<string, unknown>;
  itemSchema: Record<string, unknown>;
  resolve: (query: string) => Promise<{ lat: number; lng: number } | null>;
}

/**
 * Returns coordinates for an item: the caller-supplied pair when present,
 * otherwise the geocode of the marked composite query. Best-effort — returns
 * `{ lat: null, lng: null }` when there is nothing to geocode or it fails.
 */
export async function resolveItemCoordinates(
  args: ResolveArgs
): Promise<{ lat: number | null; lng: number | null }> {
  if (args.lat !== null && args.lng !== null) {
    return { lat: args.lat, lng: args.lng };
  }
  const fields = parseLocationFields(args.itemSchema);
  const query = buildGeoQuery(args.itemState, fields);
  if (!query) return { lat: null, lng: null };
  const coords = await args.resolve(query);
  return coords ?? { lat: null, lng: null };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter api exec vitest run src/routes/v1/item/__tests__/create_item.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the helper into the handler**

In `apps/api/src/routes/v1/item/create_item.ts`:

a. Add imports:
```ts
import { getDomainItemSchema } from '@dpg/schemas';
import { getNetworkConfigById } from '@/network_configs';
import { resolveCoordinates } from '@/services/geocoding/geo_resolver';
import { resolveItemCoordinates } from './geotag_item';
```

b. Just before the `createItemInternal` call (after the `ensureItemPartition` block), compute coords:
```ts
let lat = body.item_latitude ?? null;
let lng = body.item_longitude ?? null;
if (lat === null && lng === null) {
  try {
    const networkConfig = await getNetworkConfigById(body.item_network);
    const itemSchema = getDomainItemSchema(
      networkConfig,
      body.item_domain,
      body.item_type
    ) as Record<string, unknown> | null;
    if (itemSchema) {
      const coords = await resolveItemCoordinates({
        lat, lng,
        itemState: body.item_state ?? {},
        itemSchema,
        resolve: resolveCoordinates,
      });
      lat = coords.lat;
      lng = coords.lng;
    }
  } catch (err) {
    request.log.warn({ err, item_network: body.item_network, item_domain: body.item_domain }, 'backend geocoding failed; creating item without coordinates');
  }
}
```

c. Change the `createItemInternal` call to use the resolved values:
```ts
item_latitude: lat,
item_longitude: lng,
```
(replacing `body.item_latitude ?? null` / `body.item_longitude ?? null`).

- [ ] **Step 6: Typecheck + full API unit suite**

Run: `pnpm --filter api exec tsc --noEmit && pnpm --filter api test`
Expected: PASS (new tests + existing suite green).

- [ ] **Step 7: Run Codacy on edited files**

Analyze `apps/api/src/routes/v1/item/create_item.ts` and `apps/api/src/routes/v1/item/geotag_item.ts`.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/routes/v1/item/create_item.ts apps/api/src/routes/v1/item/geotag_item.ts apps/api/src/routes/v1/item/__tests__/create_item.test.ts
git commit -m "feat(api): geotag items on create when coordinates are absent"
```

---

## Task 11: Full verification + manual test

**Files:** none (verification only).

- [ ] **Step 1: Whole-repo typecheck**

Run: `pnpm typecheck`
Expected: PASS (api + ui).

- [ ] **Step 2: Schemas + API test suites**

Run: `pnpm --filter @dpg/schemas test && pnpm --filter api test`
Expected: PASS.

- [ ] **Step 3: Restart local services on purple_dot (clear schema cache first)**

```bash
pkill -f "tsx watch src/server.ts"; pkill -f "vite"
rm -rf "$(node -e 'console.log(require("os").tmpdir())')/dpg-network-schema-cache"
# flush Redis using REDIS_PASSWORD from .env
```
Then relaunch API (`SERVED_DOMAINS=purple_dot/seeker,purple_dot/provider`, `NETWORK_CONFIG_LOCAL_FILE=../../examples/schemas/purple_dot/network.json`) and UI (`VITE_NETWORK_ID=purple_dot`) as before. Confirm `GET /api/v1/network/schemas?network=purple_dot` returns the purple config.

- [ ] **Step 4: Manual UI test**

On `http://localhost:3000/`, create a purple_dot `seeker` profile. In the **Address** field, type a partial address → confirm suggestions appear (Photon if no key) → pick one. Submit. Verify via DB or `GET /api/v1/item/fetch` that `item_latitude`/`item_longitude` are populated.

- [ ] **Step 5: Manual API test (backend geocoding)**

Create a seeker via the API (with `x-api-key` + `x-acting-org-id` as required), payload containing `item_state.address` etc. but **no** `item_latitude/longitude`. Confirm the stored item has coordinates populated server-side. Then repeat **with** coordinates supplied and confirm they are stored unchanged.

- [ ] **Step 6: Final commit (if any verification fixups were needed)**

```bash
git add -A && git commit -m "test(geotagging): verification fixups" || echo "nothing to commit"
```

---

## Self-review notes

- **Spec coverage:** marker (Task 1–2), Google Places autocomplete (Task 4–5), Photon fallback (Task 3–4, Task 9), UI capture + composite fallback (Task 6), map migration + heuristic removal (Task 7), backend geocoding only-when-absent (Task 8–10), env (Task 8), tests (1, 2, 9, 10, 11). All spec sections map to a task.
- **Type consistency:** `LocationFields`/`parseLocationFields`/`buildGeoQuery` (schemas) reused verbatim in UI Tasks 6–7 and API Task 10; `GeoSuggestion`/`GeoProvider` consistent across Tasks 3–7; `Coordinates`/`resolveCoordinates` consistent in Task 9–10.
- **Known follow-ups (out of scope):** yellow_dot/blue_dot markers are added in Task 2 but not manually tested (no served instance locally); no backfill of existing items; self-hosted Photon.
```
