# orange_dot Tourist Discovery UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone, login-free tourist UI for `orange_dot` — a full-width map + nearest-first list of nearby practitioners (via browser geolocation) whose cards offer Call / Website / Get Directions — as a second Vite build entry inside `apps/ui` that reuses the existing map, cards, filters, geolocation, and fetch clients.

**Architecture:** UI-only. A new entry `apps/ui/index.tourist.html` → `apps/ui/src/tourist/main.tourist.tsx`, selected at build/dev time by `VITE_APP=tourist`. The signals app is never modified (the only shared file touched is `vite.config.ts`, behind a flag that is a no-op when unset). The tourist app calls the existing API anonymously (`/network/schemas`, `/network/item/fetch` — both already auth-free); no backend changes.

**Tech Stack:** React 19, Vite 8, TypeScript, @tanstack/react-query, react-i18next, Leaflet/Google maps (existing `MapView`), Tailwind, shadcn UI primitives. Tests: vitest + @testing-library/react + happy-dom (newly added to `apps/ui`).

**Spec:** `docs/superpowers/specs/2026-06-11-orange-dot-tourist-ui-design.md`

**Branch:** `orange-dot-tourist-ui`

---

## File Structure

**New files (all under `apps/ui/`):**
- `index.tourist.html` — second HTML entry; loads `/src/tourist/main.tourist.tsx`; bootstraps `data-network="orange_dot"` + dark mode.
- `src/tourist/main.tourist.tsx` — React root: `QueryClientProvider` + i18n + `<TouristApp/>`. No AuthProvider, no router.
- `src/tourist/tourist-app.tsx` — orchestration: fetch config + practitioners, resolve location, own search/viewMode/filter state, run the filter pipeline, render shell + map/list + banner + states.
- `src/tourist/tourist-top-bar.tsx` — slim app bar: search, Map/List toggle, filters slot, language + theme. No auth/sidebar/router.
- `src/tourist/tourist-map.tsx` — wraps `MapView` with practitioner markers + `PractitionerCard` popups.
- `src/tourist/tourist-list.tsx` — practitioners as `PractitionerCard`s, nearest-first.
- `src/tourist/practitioner-card.tsx` — wraps `ItemCard`, supplies `PractitionerActions`.
- `src/tourist/practitioner-actions.tsx` — the three buttons (Call / Website / Get Directions), each hidden when its field is absent.
- `src/tourist/enable-location-banner.tsx` — shown when geolocation is denied/unavailable.
- `src/tourist/practitioner-data.ts` — pure helpers: `itemToCardItem`, `getPrimaryLocation`, `matchesSearch`.
- `src/lib/geo/directions.ts` — pure helpers: `detectPlatform`, `directionsUrl`, `telHref`, `normalizeWebsiteUrl`, + `openDirections` wrapper.
- `vitest.config.ts`, `src/test/setup.ts` — test infra.
- Test files colocated: `*.test.ts(x)` next to each unit under test.

**Modified files:**
- `apps/ui/vite.config.ts` — `VITE_APP=tourist` entry selection (build input + dev root rewrite).
- `apps/ui/package.json` — `test`, `dev:tourist`, `build:tourist` scripts + test devDeps.
- `apps/ui/src/i18n/locales/en.json` — add `tourist.*` keys.
- root `package.json` — `dev:tourist`, `build:tourist` aliases (optional convenience).

**Reused read-only (do NOT modify):** `components/map/map-container.tsx` (`MapView`), `components/map/map-filters-panel.tsx` (`MapFiltersPanel`), `components/cards/item-card.tsx` (`ItemCard`), `lib/enum-filters.ts`, `hooks/use-user-location.ts`, `hooks/use-browser-location.ts`, `lib/geo/distance.ts` + `lib/geo/types.ts`, `lib/network-api.ts` (`fetchNetworkConfig`, `fetchNetworkItems`), `lib/item-api.ts` (`Item`), `components/ui/*`, `components/layout/language-switcher.tsx`, `components/layout/theme-mode-toggle.tsx`.

**Reference signatures (already in the codebase — use exactly these):**
- `MapView` props (`map-container.tsx:11-50`): `{ schema: RJSFSchema; items: Array<{id;domain?;data}>; center?: [number,number]; zoom?: number; focusPoint?: {lat;lng}|null; filtersSlot?; renderPopup?: (m: MapMarker)=>ReactNode; resolveMarkerLabel? }`. It auto-builds markers from `item.data.item_locations`.
- `ItemCard` props (`item-card.tsx:13-31`): `{ schema?; data; cardConfig?; title?; domainLabel?; precisionLabel?; actions?: ReactNode; variant?: 'popup'|'list'; className?; onClick? }`.
- `itemToCardItem` (pattern at `home-page.tsx:45-50`): `{ id: item.item_id, domain: item.item_domain, data: { ...item.item_state, item_locations: item.item_locations } }`.
- `fetchNetworkConfig(networkId): Promise<DotNetworkSchema>` and `fetchNetworkItems(query, signal?): Promise<FetchItemsResponse>` where `query = { item_network, item_domain, item_type, limit?, offset? }` (`network-api.ts`).
- `useUserLocation(profileLocation: LatLng|null, profileResolved: boolean): { location: LatLng|null; source }` (`use-user-location.ts`).
- `useBrowserLocation(): { location; status; error; isSupported; request; reset }` (`use-browser-location.ts`).
- `nearestDistanceMeters(from: LatLng, locations): number` (`distance.ts`).
- `getEnumFilterFieldsForDomains(domains)`, `itemPassesEnumFilters(data, selectedFields, enumFields)` (`enum-filters.ts`).
- `MapFiltersPanel` props (`map-filters-panel.tsx:489-505`): `{ domains; selectedDomains; onDomainsChange; selectedFields; onFieldsChange; viewMode? }`.

**Constants:** `ORANGE_NETWORK_ID = 'orange_dot'`; `ORANGE_DOMAIN_ID = 'practitioner'`; region default center Udupi `{ lat: 13.3409, lng: 74.7421 }`, zoom `12`.

---

### Task 1: Test infrastructure for `apps/ui`

`apps/ui` has no test runner today. Add vitest + RTL so the rest of the plan can do TDD.

**Files:**
- Modify: `apps/ui/package.json`
- Create: `apps/ui/vitest.config.ts`
- Create: `apps/ui/src/test/setup.ts`

- [ ] **Step 1: Install dev dependencies**

```bash
cd /Users/srivastha/KKB/Github/Signals-DPG
pnpm --filter ui add -D vitest@^3 @testing-library/react@^16 @testing-library/jest-dom@^6 @testing-library/user-event@^14 happy-dom@^15
```

After install, per CLAUDE.md run Codacy with trivy on the changed manifest (skip if Codacy MCP is unavailable in this environment):

```
codacy_cli_analyze (rootPath: repo root, tool: trivy)
```

- [ ] **Step 2: Create the vitest config**

Create `apps/ui/vitest.config.ts`. It reuses the same `@`/`@dpg` aliases as `vite.config.ts` so imports resolve identically.

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [
      {
        find: '@dpg/schemas/location_fields',
        replacement: path.resolve(__dirname, '../../packages/schemas/src/location_fields.ts'),
      },
      { find: /^@dpg\/(.*)$/, replacement: path.resolve(__dirname, '../../packages/$1/src') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
```

- [ ] **Step 3: Create the test setup file**

Create `apps/ui/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
});
```

- [ ] **Step 4: Add the `test` script**

In `apps/ui/package.json`, add to `scripts`:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 5: Add a smoke test and verify the runner works**

Create `apps/ui/src/test/smoke.test.ts`:

```ts
import { describe, it, expect } from 'vitest';

describe('test runner', () => {
  it('runs', () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `pnpm --filter ui test`
Expected: PASS (1 test). Then delete the smoke test:

```bash
rm apps/ui/src/test/smoke.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/ui/package.json apps/ui/vitest.config.ts apps/ui/src/test/setup.ts pnpm-lock.yaml
git commit -m "test(ui): add vitest + react-testing-library setup"
```

---

### Task 2: Directions / contact URL helpers (pure)

**Files:**
- Create: `apps/ui/src/lib/geo/directions.ts`
- Test: `apps/ui/src/lib/geo/directions.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/lib/geo/directions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import {
  detectPlatform,
  directionsUrl,
  telHref,
  normalizeWebsiteUrl,
  openDirections,
} from './directions';

describe('detectPlatform', () => {
  it('detects android', () => {
    expect(detectPlatform('Mozilla/5.0 (Linux; Android 13; Pixel)')).toBe('android');
  });
  it('detects ios', () => {
    expect(detectPlatform('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)')).toBe('ios');
    expect(detectPlatform('Mozilla/5.0 (iPad; CPU OS 17_0)')).toBe('ios');
  });
  it('falls back to other', () => {
    expect(detectPlatform('Mozilla/5.0 (Windows NT 10.0)')).toBe('other');
  });
});

describe('directionsUrl', () => {
  const dest = { lat: 13.34, lng: 74.74 };
  it('android → geo: chooser URI with label', () => {
    expect(directionsUrl(dest, 'Cafe', 'android')).toBe('geo:13.34,74.74?q=13.34,74.74(Cafe)');
  });
  it('android without label omits the parenthetical', () => {
    expect(directionsUrl(dest, undefined, 'android')).toBe('geo:13.34,74.74?q=13.34,74.74');
  });
  it('ios → Apple Maps directions URL', () => {
    expect(directionsUrl(dest, 'Cafe', 'ios')).toBe('https://maps.apple.com/?daddr=13.34,74.74');
  });
  it('other → Google Maps directions URL', () => {
    expect(directionsUrl(dest, 'Cafe', 'other')).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=13.34,74.74',
    );
  });
});

describe('telHref', () => {
  it('prefixes +91 for a bare 10-digit number', () => {
    expect(telHref('9876543210')).toBe('tel:+919876543210');
  });
  it('keeps a number that already has a country code', () => {
    expect(telHref('+15551234567')).toBe('tel:+15551234567');
  });
  it('strips spaces/dashes and leaves non-10-digit numbers unprefixed', () => {
    expect(telHref('044 1234 5678')).toBe('tel:04412345678');
  });
});

describe('normalizeWebsiteUrl', () => {
  it('adds https:// when no scheme', () => {
    expect(normalizeWebsiteUrl('example.com')).toBe('https://example.com');
  });
  it('keeps an existing scheme', () => {
    expect(normalizeWebsiteUrl('http://x.com')).toBe('http://x.com');
  });
});

describe('openDirections', () => {
  it('opens a new tab on desktop', () => {
    const open = vi.fn();
    const assign = vi.fn();
    const win = { navigator: { userAgent: 'Windows NT 10.0' }, open, location: { assign } } as unknown as Window;
    openDirections({ lat: 1, lng: 2 }, 'X', win);
    expect(open).toHaveBeenCalledWith('https://www.google.com/maps/dir/?api=1&destination=1,2', '_blank', 'noopener,noreferrer');
    expect(assign).not.toHaveBeenCalled();
  });
  it('navigates via location.assign on android', () => {
    const open = vi.fn();
    const assign = vi.fn();
    const win = { navigator: { userAgent: 'Android 13' }, open, location: { assign } } as unknown as Window;
    openDirections({ lat: 1, lng: 2 }, 'X', win);
    expect(assign).toHaveBeenCalledWith('geo:1,2?q=1,2(X)');
    expect(open).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ui test src/lib/geo/directions.test.ts`
Expected: FAIL — `Failed to resolve import './directions'`.

- [ ] **Step 3: Implement**

Create `apps/ui/src/lib/geo/directions.ts`:

```ts
import type { LatLng } from './types';

export type PlatformKind = 'android' | 'ios' | 'other';

/** Classify the platform from a user-agent string (pure). */
export function detectPlatform(userAgent: string): PlatformKind {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return 'other';
}

/**
 * Build a directions deep-link to `dest` for the given platform:
 *  - android: `geo:` URI → triggers the OS "open with…" map-app chooser.
 *  - ios:     Apple Maps universal link (opens the Maps app with destination set).
 *  - other:   Google Maps directions URL (web/app).
 */
export function directionsUrl(dest: LatLng, label: string | undefined, platform: PlatformKind): string {
  const { lat, lng } = dest;
  switch (platform) {
    case 'android': {
      const q = label ? `${lat},${lng}(${encodeURIComponent(label)})` : `${lat},${lng}`;
      return `geo:${lat},${lng}?q=${q}`;
    }
    case 'ios':
      return `https://maps.apple.com/?daddr=${lat},${lng}`;
    default:
      return `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  }
}

/** Build a `tel:` href. A bare 10-digit number gets the default country code. */
export function telHref(phone: string, defaultCountryCode = '+91'): string {
  const cleaned = phone.replace(/[^\d+]/g, '');
  if (cleaned.startsWith('+')) return `tel:${cleaned}`;
  if (/^\d{10}$/.test(cleaned)) return `tel:${defaultCountryCode}${cleaned}`;
  return `tel:${cleaned}`;
}

/** Ensure a website URL has a scheme so it opens as an absolute link. */
export function normalizeWebsiteUrl(url: string): string {
  const trimmed = url.trim();
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

/**
 * Open directions to `dest`. On mobile we navigate the current tab (so the OS
 * can hand off to a native maps app); on desktop we open a new tab.
 * `win` is injectable for testing.
 */
export function openDirections(dest: LatLng, label: string | undefined, win: Window = window): void {
  const platform = detectPlatform(win.navigator.userAgent);
  const url = directionsUrl(dest, label, platform);
  if (platform === 'other') {
    win.open(url, '_blank', 'noopener,noreferrer');
  } else {
    win.location.assign(url);
  }
}
```

> Note: the spec wrote the iOS link as `maps://?daddr=`; this plan uses the more robust `https://maps.apple.com/?daddr=` universal link, which still opens the Maps app on iOS but does not get blocked from a normal web page. Functionally equivalent intent.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter ui test src/lib/geo/directions.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/lib/geo/directions.ts apps/ui/src/lib/geo/directions.test.ts
git commit -m "feat(tourist): directions/tel/website URL helpers"
```

---

### Task 3: Second Vite entry + scripts (`VITE_APP=tourist`)

Wire a second build/dev entry that the existing app ignores when the flag is unset.

**Files:**
- Create: `apps/ui/index.tourist.html`
- Create: `apps/ui/src/tourist/main.tourist.tsx`
- Modify: `apps/ui/vite.config.ts`
- Modify: `apps/ui/package.json`
- Modify (root): `package.json`

- [ ] **Step 1: Create the tourist HTML entry**

Create `apps/ui/index.tourist.html` (mirrors `index.html` but hard-sets the orange network and points at the tourist entry):

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Discover</title>
    <script src="/config.js"></script>
    <script>
      (function () {
        document.documentElement.dataset.network = 'orange_dot';
        try {
          var stored = localStorage.getItem('dpg-theme-mode');
          var resolved =
            stored === 'dark' ||
            (stored === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
          if (resolved) document.documentElement.classList.add('dark');
        } catch (_) {}
      })();
    </script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/tourist/main.tourist.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: Create a minimal tourist entry (placeholder body, real providers)**

Create `apps/ui/src/tourist/main.tourist.tsx`. `TouristApp` is filled in by Task 11; for now render a sentinel so the build is verifiable.

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../i18n';
import '../index.css';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: 2 } },
});

function TouristApp() {
  return <div data-testid="tourist-root">Tourist UI</div>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <TouristApp />
    </QueryClientProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 3: Add `VITE_APP` entry selection to `vite.config.ts`**

In `apps/ui/vite.config.ts`, inside the `defineConfig(({ mode }) => { ... })` body, read the flag and add a build input + a dev root-rewrite. Add near the top of the callback (after `const env = loadEnv(...)`):

```ts
    const isTourist = env.VITE_APP === 'tourist';
    const touristEntry = path.resolve(__dirname, 'index.tourist.html');
```

Add an inline plugin to the `plugins` array (so `/` serves the tourist entry in dev):

```ts
    plugins: [
      react(),
      tailwindcss(),
      brandThemePlugin(),
      ...(isTourist
        ? [
            {
              name: 'tourist-root-entry',
              configureServer(server) {
                server.middlewares.use((req, _res, next) => {
                  if (req.url === '/' || req.url === '/index.html') req.url = '/index.tourist.html';
                  next();
                });
              },
            } as Plugin,
          ]
        : []),
    ],
```

And add a `build` key to the returned config object (alongside `server`):

```ts
    build: isTourist ? { rollupOptions: { input: touristEntry } } : undefined,
```

When `VITE_APP` is unset, `isTourist` is `false`, the plugin list and `build` are identical to today — the signals build is unchanged.

- [ ] **Step 4: Add scripts**

In `apps/ui/package.json` `scripts`:

```json
"dev:tourist": "VITE_APP=tourist VITE_NETWORK_ID=orange_dot vite",
"build:tourist": "VITE_APP=tourist VITE_NETWORK_ID=orange_dot tsc && VITE_APP=tourist VITE_NETWORK_ID=orange_dot vite build"
```

In the root `package.json` `scripts` (convenience aliases that flow root `.env`, mirroring `dev:ui`):

```json
"dev:tourist": "node scripts/turbo-with-root-env.mjs run dev:tourist --filter=ui",
"build:tourist": "node scripts/turbo-with-root-env.mjs run build:tourist --filter=ui"
```

Add matching `dev:tourist` / `build:tourist` task entries to `apps/ui` in `turbo.json` if the repo's turbo requires explicit task declarations (check `turbo.json` `tasks` — if `dev`/`build` are declared, add `dev:tourist`/`build:tourist` with the same `cache`/`persistent` settings).

- [ ] **Step 5: Verify both builds**

```bash
cd /Users/srivastha/KKB/Github/Signals-DPG
# Signals build unchanged (no flag):
pnpm --filter ui exec vite build >/tmp/build-signals.log 2>&1; echo "signals build: $?"
# Tourist build:
VITE_APP=tourist VITE_NETWORK_ID=orange_dot pnpm --filter ui exec vite build >/tmp/build-tourist.log 2>&1; echo "tourist build: $?"
```

Expected: both exit `0`. The tourist build's `dist/index.html` is generated from `index.tourist.html` (references the tourist entry). Confirm:

```bash
grep -q "main.tourist" apps/ui/dist/index.html && echo "tourist entry OK"
```

- [ ] **Step 6: Commit**

```bash
git add apps/ui/index.tourist.html apps/ui/src/tourist/main.tourist.tsx apps/ui/vite.config.ts apps/ui/package.json package.json turbo.json
git commit -m "build(tourist): second Vite entry behind VITE_APP=tourist"
```

---

### Task 4: i18n keys for the tourist actions

**Files:**
- Modify: `apps/ui/src/i18n/locales/en.json`

- [ ] **Step 1: Add the `tourist` namespace keys**

In `apps/ui/src/i18n/locales/en.json`, add a top-level `"tourist"` object (place it alphabetically among existing top-level keys):

```json
"tourist": {
  "call": "Call",
  "website": "Website",
  "directions": "Get Directions",
  "enable_location_title": "Showing all practitioners",
  "enable_location_body": "Enable location to see what's nearest to you.",
  "enable_location_cta": "Enable location",
  "empty": "No practitioners found.",
  "error": "Couldn't load practitioners.",
  "retry": "Retry",
  "loading": "Loading…"
}
```

(English is the fallback locale; `kn.json`/`hi.json` may be updated later but missing keys fall back to `en`.)

- [ ] **Step 2: Verify JSON parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('apps/ui/src/i18n/locales/en.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add apps/ui/src/i18n/locales/en.json
git commit -m "i18n(tourist): add tourist.* action + state labels"
```

---

### Task 5: Practitioner data helpers (pure)

**Files:**
- Create: `apps/ui/src/tourist/practitioner-data.ts`
- Test: `apps/ui/src/tourist/practitioner-data.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/tourist/practitioner-data.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { itemToCardItem, getPrimaryLocation, matchesSearch } from './practitioner-data';
import type { Item } from '@/lib/item-api';

const item: Item = {
  item_id: 'p1',
  item_network: 'orange_dot',
  item_domain: 'practitioner',
  item_type: 'profile_1.0',
  item_instance_url: null,
  item_schema_url: null,
  item_state: { name: 'Coastal Crafts', category: 'Handicraft' },
  item_locations: [{ lat: 13.34, lng: 74.74, label: 'Udupi' }],
  created_at: '',
  updated_at: '',
};

describe('itemToCardItem', () => {
  it('moves item_state into data and merges item_locations', () => {
    const card = itemToCardItem(item);
    expect(card).toEqual({
      id: 'p1',
      domain: 'practitioner',
      data: { name: 'Coastal Crafts', category: 'Handicraft', item_locations: [{ lat: 13.34, lng: 74.74, label: 'Udupi' }] },
    });
  });
});

describe('getPrimaryLocation', () => {
  it('returns the first location with its label', () => {
    expect(getPrimaryLocation(item.item_locations)).toEqual({ lat: 13.34, lng: 74.74, label: 'Udupi' });
  });
  it('returns null for an empty array', () => {
    expect(getPrimaryLocation([])).toBeNull();
  });
});

describe('matchesSearch', () => {
  it('is case-insensitive across string field values', () => {
    expect(matchesSearch({ name: 'Coastal Crafts' }, 'coastal')).toBe(true);
    expect(matchesSearch({ name: 'Coastal Crafts' }, 'xyz')).toBe(false);
  });
  it('matches empty query', () => {
    expect(matchesSearch({ name: 'X' }, '')).toBe(true);
  });
  it('ignores the item_locations blob', () => {
    expect(matchesSearch({ item_locations: [{ lat: 1, lng: 2 }] }, '1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ui test src/tourist/practitioner-data.test.ts`
Expected: FAIL — `Failed to resolve import './practitioner-data'`.

- [ ] **Step 3: Implement**

Create `apps/ui/src/tourist/practitioner-data.ts`:

```ts
import type { Item, ItemLocation } from '@/lib/item-api';
import type { LatLng } from '@/lib/geo/types';

export interface CardItem {
  id: string;
  domain: string;
  data: Record<string, unknown>;
}

/** Map an API Item to the {id,domain,data} shape MapView/ItemCard consume. */
export function itemToCardItem(item: Item): CardItem {
  return {
    id: item.item_id,
    domain: item.item_domain,
    data: { ...item.item_state, item_locations: item.item_locations },
  };
}

/** First location point (exact for orange practitioners), or null. */
export function getPrimaryLocation(
  locations: ItemLocation[] | undefined,
): (LatLng & { label?: string }) | null {
  const first = locations?.[0];
  return first ? { lat: first.lat, lng: first.lng, label: first.label } : null;
}

/** Case-insensitive substring match across an item's string field values. */
export function matchesSearch(data: Record<string, unknown>, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  for (const [key, value] of Object.entries(data)) {
    if (key === 'item_locations') continue;
    if (typeof value === 'string' && value.toLowerCase().includes(q)) return true;
    if (Array.isArray(value) && value.some((v) => typeof v === 'string' && v.toLowerCase().includes(q))) return true;
  }
  return false;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter ui test src/tourist/practitioner-data.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/tourist/practitioner-data.ts apps/ui/src/tourist/practitioner-data.test.ts
git commit -m "feat(tourist): practitioner data helpers (card mapping, location, search)"
```

---

### Task 6: `PractitionerActions` (the three buttons)

**Files:**
- Create: `apps/ui/src/tourist/practitioner-actions.tsx`
- Test: `apps/ui/src/tourist/practitioner-actions.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/tourist/practitioner-actions.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PractitionerActions } from './practitioner-actions';
import * as directions from '@/lib/geo/directions';

afterEach(() => vi.restoreAllMocks());

describe('PractitionerActions', () => {
  it('renders only the buttons whose data is present', () => {
    render(<PractitionerActions phone="9876543210" website={null} location={null} />);
    expect(screen.getByRole('link', { name: /call/i })).toHaveAttribute('href', 'tel:+919876543210');
    expect(screen.queryByRole('link', { name: /website/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /directions/i })).toBeNull();
  });

  it('website link opens a normalized URL in a new tab', () => {
    render(<PractitionerActions phone={null} website="coastalcrafts.in" location={null} />);
    const link = screen.getByRole('link', { name: /website/i });
    expect(link).toHaveAttribute('href', 'https://coastalcrafts.in');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('directions button calls openDirections with the location', async () => {
    const spy = vi.spyOn(directions, 'openDirections').mockImplementation(() => {});
    render(<PractitionerActions phone={null} website={null} location={{ lat: 1, lng: 2, label: 'X' }} />);
    await userEvent.click(screen.getByRole('button', { name: /directions/i }));
    expect(spy).toHaveBeenCalledWith({ lat: 1, lng: 2, label: 'X' }, 'X');
  });

  it('renders nothing when no data is present', () => {
    const { container } = render(<PractitionerActions phone={null} website={null} location={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ui test src/tourist/practitioner-actions.test.tsx`
Expected: FAIL — cannot resolve `./practitioner-actions`.

- [ ] **Step 3: Implement**

Create `apps/ui/src/tourist/practitioner-actions.tsx`:

```tsx
import { Phone, Globe, Navigation } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { LatLng } from '@/lib/geo/types';
import { telHref, normalizeWebsiteUrl, openDirections } from '@/lib/geo/directions';

export interface PractitionerActionsProps {
  phone?: string | null;
  website?: string | null;
  location?: (LatLng & { label?: string }) | null;
}

/** Call / Website / Get Directions. Each button is omitted if its field is absent. */
export function PractitionerActions({ phone, website, location }: PractitionerActionsProps) {
  const { t } = useTranslation();
  if (!phone && !website && !location) return null;

  return (
    <div className="flex w-full gap-2">
      {phone && (
        <Button asChild variant="outline" size="sm" className="flex-1">
          <a href={telHref(phone)}>
            <Phone className="mr-1.5 h-3.5 w-3.5" />
            {t('tourist.call')}
          </a>
        </Button>
      )}
      {website && (
        <Button asChild variant="outline" size="sm" className="flex-1">
          <a href={normalizeWebsiteUrl(website)} target="_blank" rel="noopener noreferrer">
            <Globe className="mr-1.5 h-3.5 w-3.5" />
            {t('tourist.website')}
          </a>
        </Button>
      )}
      {location && (
        <Button
          variant="default"
          size="sm"
          className="flex-1"
          onClick={() => openDirections(location, location.label)}
        >
          <Navigation className="mr-1.5 h-3.5 w-3.5" />
          {t('tourist.directions')}
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter ui test src/tourist/practitioner-actions.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/tourist/practitioner-actions.tsx apps/ui/src/tourist/practitioner-actions.test.tsx
git commit -m "feat(tourist): PractitionerActions (Call/Website/Get Directions)"
```

---

### Task 7: `PractitionerCard` (ItemCard + actions)

**Files:**
- Create: `apps/ui/src/tourist/practitioner-card.tsx`
- Test: `apps/ui/src/tourist/practitioner-card.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/tourist/practitioner-card.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PractitionerCard } from './practitioner-card';

const data = {
  name: 'Coastal Crafts',
  contact_phone: '9876543210',
  website: 'coastalcrafts.in',
  item_locations: [{ lat: 13.34, lng: 74.74, label: 'Udupi' }],
};

describe('PractitionerCard', () => {
  it('renders the practitioner name and all three actions', () => {
    render(<PractitionerCard data={data} schema={null} variant="popup" />);
    expect(screen.getByText('Coastal Crafts')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /call/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /website/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /directions/i })).toBeInTheDocument();
  });

  it('omits actions for missing fields', () => {
    render(<PractitionerCard data={{ name: 'No Contact', item_locations: [] }} schema={null} variant="popup" />);
    expect(screen.queryByRole('link', { name: /call/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /directions/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ui test src/tourist/practitioner-card.test.tsx`
Expected: FAIL — cannot resolve `./practitioner-card`.

- [ ] **Step 3: Implement**

Create `apps/ui/src/tourist/practitioner-card.tsx`:

```tsx
import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig } from '@/engine/types';
import { ItemCard } from '@/components/cards/item-card';
import { PractitionerActions } from './practitioner-actions';
import { getPrimaryLocation } from './practitioner-data';
import type { ItemLocation } from '@/lib/item-api';

export interface PractitionerCardProps {
  data: Record<string, unknown>;
  schema?: RJSFSchema | null;
  cardConfig?: DotCardConfig | null;
  title?: string;
  variant?: 'popup' | 'list';
  className?: string;
}

/** ItemCard for an orange practitioner with Call/Website/Get Directions actions. */
export function PractitionerCard({ data, schema, cardConfig, title, variant = 'list', className }: PractitionerCardProps) {
  const phone = typeof data.contact_phone === 'string' ? data.contact_phone : null;
  const website = typeof data.website === 'string' ? data.website : null;
  const location = getPrimaryLocation(data.item_locations as ItemLocation[] | undefined);

  return (
    <ItemCard
      schema={schema}
      cardConfig={cardConfig}
      data={data}
      title={title}
      variant={variant}
      className={className}
      actions={<PractitionerActions phone={phone} website={website} location={location} />}
    />
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter ui test src/tourist/practitioner-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/tourist/practitioner-card.tsx apps/ui/src/tourist/practitioner-card.test.tsx
git commit -m "feat(tourist): PractitionerCard wrapping ItemCard with the three actions"
```

---

### Task 8: `EnableLocationBanner`

**Files:**
- Create: `apps/ui/src/tourist/enable-location-banner.tsx`
- Test: `apps/ui/src/tourist/enable-location-banner.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/tourist/enable-location-banner.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { EnableLocationBanner } from './enable-location-banner';

describe('EnableLocationBanner', () => {
  it('renders body text and an enable button that calls onEnable', async () => {
    const onEnable = vi.fn();
    render(<EnableLocationBanner onEnable={onEnable} />);
    expect(screen.getByText(/showing all practitioners/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /enable location/i }));
    expect(onEnable).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ui test src/tourist/enable-location-banner.test.tsx`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

Create `apps/ui/src/tourist/enable-location-banner.tsx`:

```tsx
import { MapPin } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export interface EnableLocationBannerProps {
  onEnable: () => void;
}

/** Shown when geolocation is denied/unavailable: all practitioners are shown; offer to enable. */
export function EnableLocationBanner({ onEnable }: EnableLocationBannerProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-3 border-b bg-muted/50 px-4 py-2 text-sm">
      <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="flex-1">
        <span className="font-medium">{t('tourist.enable_location_title')}</span>{' '}
        <span className="text-muted-foreground">{t('tourist.enable_location_body')}</span>
      </div>
      <Button size="sm" variant="outline" onClick={onEnable}>
        {t('tourist.enable_location_cta')}
      </Button>
    </div>
  );
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter ui test src/tourist/enable-location-banner.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/tourist/enable-location-banner.tsx apps/ui/src/tourist/enable-location-banner.test.tsx
git commit -m "feat(tourist): EnableLocationBanner"
```

---

### Task 9: `TouristTopBar`

A slim app bar reproducing the signals controls minus auth/sidebar/router.

**Files:**
- Create: `apps/ui/src/tourist/tourist-top-bar.tsx`
- Test: `apps/ui/src/tourist/tourist-top-bar.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/tourist/tourist-top-bar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TouristTopBar } from './tourist-top-bar';

describe('TouristTopBar', () => {
  it('renders search, view toggle, and the filters slot; no auth controls', async () => {
    const onSearch = vi.fn();
    const onView = vi.fn();
    render(
      <TouristTopBar
        search=""
        onSearchChange={onSearch}
        viewMode="map"
        onViewModeChange={onView}
        filtersSlot={<div data-testid="filters" />}
      />,
    );
    await userEvent.type(screen.getByRole('searchbox'), 'cafe');
    expect(onSearch).toHaveBeenCalled();
    expect(screen.getByTestId('filters')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /log in/i })).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ui test src/tourist/tourist-top-bar.test.tsx`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

Create `apps/ui/src/tourist/tourist-top-bar.tsx` (composes the same leaf controls `TopBar` uses — `Input`, `ToggleGroup`, `LanguageSwitcher`, `ThemeModeToggle` — without `useNavigate`/`useAuth`/`SidebarTrigger`):

```tsx
import { Search, List, MapPinned } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { LanguageSwitcher } from '@/components/layout/language-switcher';
import { ThemeModeToggle } from '@/components/layout/theme-mode-toggle';
import type { ViewMode } from '@/engine/types';
import type { ReactNode } from 'react';

export interface TouristTopBarProps {
  search: string;
  onSearchChange: (value: string) => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  filtersSlot?: ReactNode;
}

export function TouristTopBar({ search, onSearchChange, viewMode, onViewModeChange, filtersSlot }: TouristTopBarProps) {
  const { t } = useTranslation();
  return (
    <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b bg-gradient-to-r from-background to-primary/5 px-4 sm:px-6">
      <div className="relative flex-1 max-w-md">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input
          type="search"
          placeholder={t('common.search')}
          className="pl-8"
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
        />
      </div>
      {filtersSlot}
      <div className="ml-auto flex items-center gap-2">
        <ToggleGroup
          type="single"
          value={viewMode}
          onValueChange={(value) => {
            if (value) onViewModeChange(value as ViewMode);
          }}
        >
          <ToggleGroupItem value="map" aria-label={t('nav.map_view')}>
            <MapPinned className="h-4 w-4" />
          </ToggleGroupItem>
          <ToggleGroupItem value="list" aria-label={t('nav.list_view')}>
            <List className="h-4 w-4" />
          </ToggleGroupItem>
        </ToggleGroup>
        <LanguageSwitcher />
        <ThemeModeToggle />
      </div>
    </header>
  );
}
```

> If `LanguageSwitcher` or `ThemeModeToggle` import a provider/context not mounted in the tourist tree, the test in Step 2 will surface it — in that case wrap the needed provider in `main.tourist.tsx` (e.g. `next-themes` `ThemeProvider`) and re-run. (`ThemeModeToggle` uses `next-themes`; mount its provider in Task 11 if required.)

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter ui test src/tourist/tourist-top-bar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/tourist/tourist-top-bar.tsx apps/ui/src/tourist/tourist-top-bar.test.tsx
git commit -m "feat(tourist): TouristTopBar (search + view toggle + filters, no auth)"
```

---

### Task 10: `TouristMap` and `TouristList`

Thin presentational wrappers fed already-filtered card items by `TouristApp`.

**Files:**
- Create: `apps/ui/src/tourist/tourist-map.tsx`
- Create: `apps/ui/src/tourist/tourist-list.tsx`
- Test: `apps/ui/src/tourist/tourist-list.test.tsx`

- [ ] **Step 1: Write the failing test (list nearest-first ordering)**

Create `apps/ui/src/tourist/tourist-list.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TouristList } from './tourist-list';
import type { CardItem } from './practitioner-data';

const near: CardItem = { id: 'near', domain: 'practitioner', data: { name: 'Near', item_locations: [{ lat: 13.34, lng: 74.74 }] } };
const far: CardItem = { id: 'far', domain: 'practitioner', data: { name: 'Far', item_locations: [{ lat: 19.0, lng: 72.8 }] } };

describe('TouristList', () => {
  it('orders nearest-first when a user location is provided', () => {
    render(<TouristList items={[far, near]} schema={null} cardConfig={null} userLocation={{ lat: 13.35, lng: 74.75 }} />);
    const names = screen.getAllByText(/Near|Far/).map((el) => el.textContent);
    expect(names[0]).toBe('Near');
  });

  it('renders an empty state when there are no items', () => {
    render(<TouristList items={[]} schema={null} cardConfig={null} userLocation={null} />);
    expect(screen.getByText(/no practitioners/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter ui test src/tourist/tourist-list.test.tsx`
Expected: FAIL — cannot resolve `./tourist-list`.

- [ ] **Step 3: Implement `tourist-list.tsx`**

```tsx
import * as React from 'react';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig } from '@/engine/types';
import type { LatLng } from '@/lib/geo/types';
import { nearestDistanceMeters } from '@/lib/geo/distance';
import { PractitionerCard } from './practitioner-card';
import type { CardItem } from './practitioner-data';

export interface TouristListProps {
  items: CardItem[];
  schema: RJSFSchema | null;
  cardConfig: DotCardConfig | null;
  userLocation: LatLng | null;
}

function getLocations(data: Record<string, unknown>): Array<{ lat: number; lng: number }> {
  const raw = data.item_locations;
  return Array.isArray(raw) ? (raw as Array<{ lat: number; lng: number }>) : [];
}

export function TouristList({ items, schema, cardConfig, userLocation }: TouristListProps) {
  const { t } = useTranslation();

  const sorted = React.useMemo(() => {
    if (!userLocation) return items;
    return [...items].sort(
      (a, b) =>
        nearestDistanceMeters(userLocation, getLocations(a.data)) -
        nearestDistanceMeters(userLocation, getLocations(b.data)),
    );
  }, [items, userLocation]);

  if (sorted.length === 0) {
    return <p className="p-8 text-center text-sm text-muted-foreground">{t('tourist.empty')}</p>;
  }

  return (
    <div className="grid gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
      {sorted.map((item) => (
        <PractitionerCard key={item.id} data={item.data} schema={schema} cardConfig={cardConfig} variant="list" />
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Implement `tourist-map.tsx`**

```tsx
import type { RJSFSchema } from '@rjsf/utils';
import type { DotCardConfig, MapMarker } from '@/engine/types';
import type { LatLng } from '@/lib/geo/types';
import { MapView } from '@/components/map/map-container';
import { PractitionerCard } from './practitioner-card';
import type { CardItem } from './practitioner-data';

export interface TouristMapProps {
  items: CardItem[];
  schema: RJSFSchema;
  cardConfig: DotCardConfig | null;
  /** Tourist location, or null → caller passes the region default via `center`. */
  focusPoint: LatLng | null;
  center: [number, number];
  zoom: number;
  filtersSlot?: React.ReactNode;
}

export function TouristMap({ items, schema, cardConfig, focusPoint, center, zoom, filtersSlot }: TouristMapProps) {
  return (
    <MapView
      schema={schema}
      items={items}
      center={center}
      zoom={zoom}
      focusPoint={focusPoint}
      filtersSlot={filtersSlot}
      renderPopup={(marker: MapMarker) => (
        <PractitionerCard data={marker.data} schema={schema} cardConfig={cardConfig} title={marker.label} variant="popup" />
      )}
    />
  );
}
```

- [ ] **Step 5: Run to verify the list test passes**

Run: `pnpm --filter ui test src/tourist/tourist-list.test.tsx`
Expected: PASS (Near before Far; empty state renders).

- [ ] **Step 6: Commit**

```bash
git add apps/ui/src/tourist/tourist-map.tsx apps/ui/src/tourist/tourist-list.tsx apps/ui/src/tourist/tourist-list.test.tsx
git commit -m "feat(tourist): TouristMap + TouristList (nearest-first)"
```

---

### Task 11: `TouristApp` orchestration + wire entry

Pulls everything together: fetch, location, filter pipeline, states, layout.

**Files:**
- Create: `apps/ui/src/tourist/tourist-app.tsx`
- Modify: `apps/ui/src/tourist/main.tourist.tsx`

- [ ] **Step 1: Implement `tourist-app.tsx`**

```tsx
import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import type { RJSFSchema } from '@rjsf/utils';
import { fetchNetworkConfig, fetchNetworkItems } from '@/lib/network-api';
import type { Item } from '@/lib/item-api';
import { useUserLocation } from '@/hooks/use-user-location';
import { useBrowserLocation } from '@/hooks/use-browser-location';
import { getEnumFilterFieldsForDomains, itemPassesEnumFilters } from '@/lib/enum-filters';
import { MapFiltersPanel } from '@/components/map/map-filters-panel';
import { Button } from '@/components/ui/button';
import type { ViewMode } from '@/engine/types';
import { TouristTopBar } from './tourist-top-bar';
import { TouristMap } from './tourist-map';
import { TouristList } from './tourist-list';
import { EnableLocationBanner } from './enable-location-banner';
import { itemToCardItem, matchesSearch, type CardItem } from './practitioner-data';

const ORANGE_NETWORK_ID = (import.meta.env.VITE_NETWORK_ID || 'orange_dot').split(',')[0].trim();
const ORANGE_DOMAIN_ID = 'practitioner';
const REGION_DEFAULT_CENTER: [number, number] = [13.3409, 74.7421]; // Udupi
const REGION_DEFAULT_ZOOM = 12;

export function TouristApp() {
  const { t } = useTranslation();
  const [search, setSearch] = React.useState('');
  const [viewMode, setViewMode] = React.useState<ViewMode>('map');
  const [selectedFields, setSelectedFields] = React.useState<Record<string, string[]>>({});

  // Browser-geo only (no profile): auto-request once on load.
  const { location: userLocation } = useUserLocation(null, true);
  const browser = useBrowserLocation();

  const configQuery = useQuery({
    queryKey: ['tourist', 'config', ORANGE_NETWORK_ID],
    queryFn: () => fetchNetworkConfig(ORANGE_NETWORK_ID),
  });

  const network = configQuery.data ?? null;
  const domain = network?.domains.find((d) => d.id === ORANGE_DOMAIN_ID) ?? null;
  const itemType = domain?.item_schemas ? Object.keys(domain.item_schemas)[0] ?? 'profile_1.0' : 'profile_1.0';
  const schema = (domain?.item_schemas?.[itemType] ?? null) as RJSFSchema | null;
  const cardConfig = domain?.card ?? null;

  const itemsQuery = useQuery({
    enabled: !!network,
    queryKey: ['tourist', 'items', ORANGE_NETWORK_ID, ORANGE_DOMAIN_ID, itemType],
    queryFn: ({ signal }) =>
      fetchNetworkItems(
        { item_network: ORANGE_NETWORK_ID, item_domain: ORANGE_DOMAIN_ID, item_type: itemType, limit: 100 },
        signal,
      ),
  });

  const enumFields = React.useMemo(
    () => (domain ? getEnumFilterFieldsForDomains([domain]) : []),
    [domain],
  );

  const cardItems: CardItem[] = React.useMemo(() => {
    const items = (itemsQuery.data?.items ?? []) as Item[];
    return items
      .map(itemToCardItem)
      .filter((c) => matchesSearch(c.data, search))
      .filter((c) => itemPassesEnumFilters(c.data, selectedFields, enumFields));
  }, [itemsQuery.data, search, selectedFields, enumFields]);

  const filtersSlot = domain ? (
    <MapFiltersPanel
      domains={[domain]}
      selectedDomains={[]}
      onDomainsChange={() => {}}
      selectedFields={selectedFields}
      onFieldsChange={setSelectedFields}
      viewMode={viewMode}
    />
  ) : null;

  const locationDenied = !userLocation && (browser.status === 'error' || !browser.isSupported);

  return (
    <div className="flex h-screen flex-col">
      <TouristTopBar
        search={search}
        onSearchChange={setSearch}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filtersSlot={filtersSlot}
      />
      {locationDenied && <EnableLocationBanner onEnable={() => void browser.request()} />}

      <main className="min-h-0 flex-1 overflow-auto">
        {configQuery.isError || itemsQuery.isError ? (
          <div className="flex flex-col items-center gap-3 p-12 text-center">
            <p className="text-sm text-muted-foreground">{t('tourist.error')}</p>
            <Button variant="outline" size="sm" onClick={() => { void configQuery.refetch(); void itemsQuery.refetch(); }}>
              {t('tourist.retry')}
            </Button>
          </div>
        ) : !network || !schema ? (
          <p className="p-12 text-center text-sm text-muted-foreground">{t('tourist.loading')}</p>
        ) : viewMode === 'map' ? (
          <TouristMap
            items={cardItems}
            schema={schema}
            cardConfig={cardConfig}
            focusPoint={userLocation}
            center={userLocation ? [userLocation.lat, userLocation.lng] : REGION_DEFAULT_CENTER}
            zoom={REGION_DEFAULT_ZOOM}
            filtersSlot={filtersSlot}
          />
        ) : (
          <TouristList items={cardItems} schema={schema} cardConfig={cardConfig} userLocation={userLocation} />
        )}
      </main>
    </div>
  );
}
```

- [ ] **Step 2: Wire `TouristApp` into the entry**

Replace the placeholder `TouristApp` in `apps/ui/src/tourist/main.tourist.tsx` with an import, and mount the `next-themes` provider (so `ThemeModeToggle` works). Final file:

```tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from 'next-themes';
import '../i18n';
import '../index.css';
import { TouristApp } from './tourist-app';

const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 0, retry: 2 } },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false} storageKey="dpg-theme-mode">
      <QueryClientProvider client={queryClient}>
        <TouristApp />
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
```

> Match the `ThemeProvider` props to how the signals app configures `next-themes` — check `apps/ui/src/components/layout/theme-mode-toggle.tsx` / any existing `ThemeProvider` usage and mirror `attribute`/`storageKey`/`defaultTheme` exactly so the orange brand + dark mode behave identically.

- [ ] **Step 3: Typecheck + build the tourist app**

```bash
cd /Users/srivastha/KKB/Github/Signals-DPG
pnpm --filter ui exec tsc --noEmit; echo "tsc: $?"
VITE_APP=tourist VITE_NETWORK_ID=orange_dot pnpm --filter ui exec vite build >/tmp/build-tourist.log 2>&1; echo "build: $?"
```

Expected: both `0`.

- [ ] **Step 4: Run the full UI test suite**

Run: `pnpm --filter ui test`
Expected: PASS (all tourist tests green).

- [ ] **Step 5: Commit**

```bash
git add apps/ui/src/tourist/tourist-app.tsx apps/ui/src/tourist/main.tourist.tsx
git commit -m "feat(tourist): TouristApp orchestration + entry wiring"
```

---

### Task 12: Manual verification against a running stack

**Files:** none (verification only).

- [ ] **Step 1: Run the orange backend + tourist UI**

Bring up the API serving `orange_dot` (use the `run-signals-dpg` skill for the API + db + redis with `NET_DIR=orange_dot`). Then run the tourist UI dev server:

```bash
cd /Users/srivastha/KKB/Github/Signals-DPG
pnpm --filter ui dev:tourist
```

Open http://localhost:3000.

- [ ] **Step 2: Verify the experience**

Confirm, in the browser:
- The browser prompts for location on load; **no** login screen, **no** sidebar.
- App bar shows search, a Filters pill (enum fields like category), Map/List toggle, language + theme.
- Map centers on your location (or Udupi if you deny) and shows practitioner markers.
- A marker popup shows the practitioner card with Call / Website / Get Directions (only for present fields).
- Get Directions opens a maps app/tab to the practitioner's coordinates; Call opens the dialer with `+91…`; Website opens in a new tab.
- List view shows practitioners nearest-first; denying location shows the Enable-location banner and all practitioners.

- [ ] **Step 3: Confirm the signals app is unaffected**

```bash
# In a separate run (no VITE_APP), the normal app still builds + serves as before.
pnpm --filter ui exec vite build >/tmp/build-signals.log 2>&1; echo "signals build: $?"
```

Expected: `0`, and `apps/ui/dist/index.html` references `/src/main.tsx` (not the tourist entry).

- [ ] **Step 4: Final typecheck across the repo**

```bash
pnpm typecheck
```

Expected: exit `0`.

---

## Self-Review

**1. Spec coverage**

| Spec requirement | Task |
|---|---|
| UI-only, no backend changes | Architecture; Tasks fetch anonymously via existing clients |
| Second Vite entry, `VITE_APP=tourist` | Task 3 |
| No login / no sidebar / no profiles / no actions | Tasks 9, 11 (no AuthProvider/router/sidebar; `TouristTopBar` has no auth) |
| App bar keeps search + filters + Map/List toggle + lang/theme | Task 9 (`TouristTopBar`) + Task 11 (`MapFiltersPanel` slot) |
| Map + nearest-first list | Tasks 10, 11 |
| Browser geolocation, auto-request | Task 11 (`useUserLocation(null, true)`) |
| Region default + Enable-location banner when denied | Tasks 8, 11 |
| Call / Website / Get Directions (platform-aware) | Tasks 2, 6, 7 |
| Each action hidden when its field is absent | Tasks 6, 7 |
| Exact practitioner location for directions | Task 5 (`getPrimaryLocation`), Task 11 |
| Tests for directions + card actions | Tasks 2, 6, 7 (+ 5, 8, 9, 10) |
| Orange branding | Task 3 (`data-network="orange_dot"` + existing brand plugin) |

**2. Placeholder scan:** No `TODO`/`TBD`; every code step has complete code; commands have expected output. Two explicit "verify against the codebase" notes (turbo task declaration in Task 3; `ThemeProvider` props in Task 11) are confirmations of existing config, not deferred work.

**3. Type consistency:** `CardItem` is defined in Task 5 (`practitioner-data.ts`) and imported by Tasks 10 & 11. `PractitionerActions` props (`phone`/`website`/`location`) are consistent across Tasks 6 & 7. `MapView`/`ItemCard`/`MapFiltersPanel`/`fetchNetworkItems`/`useUserLocation` signatures match the real code cited in the File Structure section. `ViewMode` imported from `@/engine/types` consistently.
