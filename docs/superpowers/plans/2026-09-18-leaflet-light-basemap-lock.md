# Leaflet: lock the basemap to light, notify once in dark mode

**Date:** 2026-09-18
**Status:** plan (not implemented)
**Scope:** `apps/ui` only. No API, no env, no infra changes.

## 1. Problem and root cause

In dark mode the Leaflet map renders a basemap stamped with a diagonal
`API KEY REQUIRED · carto.com/basemaps/apikey` watermark across every tile.
Light mode is unaffected.

Root cause: the two themes use two different tile providers
(`apps/ui/src/components/map/providers/leaflet-provider.tsx:376-388`).

| Theme | Tile URL | Status |
|---|---|---|
| light | `https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png` | free, works |
| dark | `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png` | CARTO now key-gated |

CARTO has moved its basemaps behind an API key and serves keyless requests as
a **watermarked tile**, not an error. Verified in-browser (chrome-devtools) on
`localhost:5173` with the default `VITE_MAP_PROVIDER=leaflet`:

- dark: 20 tiles requested, all `basemaps.cartocdn.com/dark_all/...@2x.png`,
  every one **HTTP 200**, `loaded: 20`, `broken: 0` — and the rendered map shows
  the watermark.
- the same tile fetched outside the browser returns `HTTP/2 200`, a 66 KB PNG
  with the watermark baked into the image.
- light: 15 tiles, all `tile.openstreetmap.org`, no watermark.

So there is no network failure, no CSP block, no CSS/stacking bug to fix. The
free CARTO tier simply ended.

## 2. Decision

Stop using CARTO. **Leaflet always renders the light OpenStreetMap basemap**,
in every theme. The rest of the app keeps switching light/dark exactly as it
does today. The user is told once, via an auto-dismissing toast, that the map
stays light in dark mode.

Rationale: OSM is the only tile source in use that needs no key, no account and
no per-deployment secret. Keeping one tile source also removes the
theme-dependent `key` remount of the tile layer.

Explicitly **not** doing (see §8 for why):

- adding a CARTO API key + a new `VITE_*` secret,
- swapping in Esri Dark Gray Canvas,
- CSS-inverting the OSM tiles to fake a dark basemap.

## 3. Affected files

| File | Change |
|---|---|
| `apps/ui/src/components/map/providers/leaflet-provider.tsx` | single light `TileLayer`; add the one-shot dark-mode notice |
| `apps/ui/src/i18n/locales/en.json` | new `map.dark_basemap_notice` key |
| `apps/ui/src/i18n/locales/hi.json` | same key, translated |
| `apps/ui/src/i18n/locales/kn.json` | same key, translated |
| `apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx` | flip the dark-basemap test, add notice tests |
| `apps/ui/src/tourist/tourist-app.tsx` | mount `<Toaster />` (optional, Phase 5) |

Google Maps provider (`google-maps-provider.tsx:739`) is untouched — it has a
real dark style and no tile-key problem.

## 4. Phase 1 — force the light basemap

`leaflet-provider.tsx`. Replace the theme-branched `TileLayer` with one constant
layer. The `key` prop goes away with the branch: it existed only to force a
clean tile-layer swap on theme change, and there is no swap any more.

```diff
-      {/* Dark basemap (CARTO dark_all) in dark mode, light OSM otherwise. `key`
-          forces a clean tile-layer swap on theme change. */}
-      <TileLayer
-        key={isDark ? 'dark' : 'light'}
-        attribution={
-          isDark
-            ? '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>'
-            : '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
-        }
-        url={
-          isDark
-            ? 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png'
-            : 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
-        }
-      />
+      {/*
+       * ONE basemap in every theme: light OSM. The dark basemap used to be
+       * CARTO `dark_all`, which is now API-key-gated — keyless requests still
+       * return HTTP 200 but the PNG itself carries an "API KEY REQUIRED"
+       * watermark, so dark mode rendered a defaced map with nothing to catch
+       * it (no failed request, no console error). OSM needs no key, so the map
+       * stays light while the rest of the app follows the theme. The user is
+       * told once per session — see DarkBasemapNotice below.
+       */}
+      <TileLayer
+        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
+        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
+      />
```

`isDark` stays — Phase 2 uses it. Nothing else in the provider reads the theme.

**Scope of "light":** this pins the *basemap tiles* only. Marker pins, cluster
bubbles and the popup card keep following the app theme, which is intentional:
pins are drawn from `--primary` / `--primary-foreground` (brand colours, set
per-network and unchanged by dark mode — `index.css:274`), and cluster chips are
already hardcoded white-on-dark-text. A popup card in dark mode will render dark
on a light map; see §7 for the optional follow-up that also pins the map's own
surfaces to light.

## 5. Phase 2 — one-shot dark-mode notice

Requirement: a simple auto-closing popup saying dark mode is off for maps when
using OpenStreetMap.

Use the existing toast stack (`sonner`), already mounted app-wide in
`apps/ui/src/app.tsx:23` with `position="top-center"`, `richColors`,
`closeButton` and `toastOptions={{ duration: 5000 }}` — so "auto close" is the
default behaviour, no new dependency and no new modal component.

Add to `leaflet-provider.tsx`:

```tsx
import { toast } from 'sonner';

/**
 * Session-scoped so the notice appears once, not on every remount: the map
 * remounts on route changes and on the maximize toggle, and re-toasting there
 * would nag. `sessionStorage` (not `localStorage`) so a new tab says it again —
 * this explains a visible oddity, and a user who never saw it deserves to.
 */
const DARK_BASEMAP_NOTICE_KEY = 'dpg-map-dark-basemap-notice';

function markNoticeShown(): boolean {
  try {
    if (sessionStorage.getItem(DARK_BASEMAP_NOTICE_KEY)) return false;
    sessionStorage.setItem(DARK_BASEMAP_NOTICE_KEY, '1');
    return true;
  } catch {
    // sessionStorage may be disabled (private mode). Show the notice rather
    // than swallow it; the `id` below still prevents a visible stack.
    return true;
  }
}
```

and inside `LeafletMapProvider`, next to the existing `isDark`:

```tsx
  React.useEffect(() => {
    if (!isDark) return;
    if (!markNoticeShown()) return;
    toast.info(t('map.dark_basemap_notice'), {
      // Stable id: a second call updates the existing toast instead of
      // stacking a duplicate, even if two maps mount at once.
      id: 'map-dark-basemap',
      duration: 6000,
    });
  }, [isDark, t]);
```

Behaviour:

- lands in dark mode → notice on map mount,
- toggles light → dark while the map is open → notice fires on the same effect,
- toggles back and forth, navigates, maximizes the map → silent,
- light mode → never fires,
- Google Maps provider → never fires (the effect lives in the Leaflet provider).

`t` comes from the `useTranslation()` call already present in the component.

## 6. Phase 3 — copy

One key, added to all three locale files (`apps/ui/src/i18n/locales/`). Every
file is glob-loaded eagerly by `i18n/index.ts`, so a key missing from `hi`/`kn`
silently falls back to the key string — add all three in the same commit.

`en.json` (next to the other `map.*` keys):

```json
"map.dark_basemap_notice": "Dark mode is off for the map — OpenStreetMap has no dark basemap. The rest of the app stays dark."
```

`hi.json`:

```json
"map.dark_basemap_notice": "मानचित्र के लिए डार्क मोड बंद है — OpenStreetMap में डार्क बेसमैप नहीं है। बाकी ऐप डार्क ही रहेगा।"
```

`kn.json`:

```json
"map.dark_basemap_notice": "ನಕ್ಷೆಗೆ ಡಾರ್ಕ್ ಮೋಡ್ ಆಫ್ ಆಗಿದೆ — OpenStreetMap ನಲ್ಲಿ ಡಾರ್ಕ್ ಬೇಸ್‌ಮ್ಯಾಪ್ ಇಲ್ಲ. ಉಳಿದ ಆ್ಯಪ್ ಡಾರ್ಕ್ ಆಗಿಯೇ ಇರುತ್ತದೆ."
```

Have a native speaker confirm the `hi`/`kn` strings before merge; the English
one is the contract.

## 7. Phase 4 — tests

`apps/ui/src/components/map/providers/__tests__/map-providers.test.tsx`.

**a. Flip the existing dark test** (currently at :596, asserts the CARTO URL —
it will fail the moment Phase 1 lands, which is the point):

```diff
-  it('swaps to the CARTO dark basemap (and its attribution) in dark mode', () => {
+  it('keeps the light OSM basemap in dark mode (CARTO is key-gated)', () => {
     bridge().themeMode = 'dark';
     bridge().map = createFakeLeafletMap();
     render(leafletElement());

     const tiles = screen.getByTestId('tile-layer');
     expect(tiles).toHaveAttribute(
       'data-url',
-      'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
+      'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
     );
-    expect(tiles.getAttribute('data-attribution')).toContain('carto.com');
+    expect(tiles.getAttribute('data-attribution')).not.toContain('carto.com');
   });
```

The light-mode test at :584 stays as-is and now doubles as the invariant.

**b. New notice tests.** Mock `sonner` at the top of the file (hoisted, same
shape other suites use — `apps/ui/src/test/setup.ts:56` already tolerates a
partial stub):

```ts
vi.mock('sonner', () => ({ toast: { info: vi.fn() } }));
```

Cases:

1. dark mode → `toast.info` called once, with the `map.dark_basemap_notice` key
   (the suite's `t` stub returns the key),
2. light mode → `toast.info` not called,
3. re-render / second mount in the same session → still exactly one call
   (guards the `sessionStorage` sentinel),
4. Google provider rendered in dark mode → `toast.info` not called.

`sessionStorage.clear()` in the existing `beforeEach`, or cases 1 and 3
interfere.

**c. Commands**

```bash
pnpm --filter ui exec vitest run src/components/map/providers/__tests__/map-providers.test.tsx
pnpm --filter ui test
pnpm typecheck
```

## 8. Phase 5 — optional follow-ups

Both are separable; neither blocks Phases 1-4.

**a. Toast in the tourist app.** `apps/ui/src/tourist/main.tourist.tsx` mounts
`ThemeModeProvider` but no `<Toaster />`, so a tourist user in dark mode gets no
notice (sonner's `toast()` is a silent no-op with no `<Toaster />` mounted — no
crash). Mount the same `<Toaster position="top-center" richColors closeButton />`
in `tourist-app.tsx` if the notice matters there.

**b. Pin the map's own surfaces to light.** Phase 1 only pins the tiles; a popup
card in dark mode is a dark card on a light map. If that reads as broken, scope
the neutral tokens back to their light values on the map wrapper:

```css
/* index.css — alongside the existing .leaflet-popup rules */
.dark .dpg-map-light,
.dark .leaflet-popup.dpg-marker-popup {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0 0);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0 0);
  --muted: oklch(0.97 0 0);
  --muted-foreground: oklch(0.556 0 0);
  --border: oklch(0.922 0 0);
}
```

(values mirror the `:root` block at `index.css:5-23` — re-copy them at
implementation time rather than trusting this snippet) and add `dpg-map-light`
to the `MapContainer` className. Caveat that makes this a
separate decision, not a freebie: Tailwind's `dark` variant is declared as
`@custom-variant dark (&:is(.dark *))` (`index.css:3`), i.e. it matches on the
`<html>` ancestor — so any component inside the map that uses a literal
`dark:` utility class keeps flipping regardless of the token override. Token
overrides fix token-driven colours only. Audit `MarkerPopupCard` and
`PractitionerCard` for `dark:` classes before committing to this.

## 9. Alternatives considered

| Option | Key? | Verdict |
|---|---|---|
| CARTO `dark_all` + API key | yes | Rejected: a new per-deployment secret and a signup for one cosmetic feature. Revisit if a keyed tile budget already exists. |
| Esri Dark Gray Canvas | no | Verified working (HTTP 200, clean tile, `{z}/{y}/{x}` order) but labels need a second Reference layer, and it adds a third tile vendor + attribution. |
| OSM + CSS `invert()` in dark | no | Cheap, but inverted tiles wash out water/landuse and misrender the label halos; it looks synthetic next to the real dark UI. |
| Stadia Alidade Smooth Dark | yes | Verified `HTTP 401` keyless. Not a drop-in. |

## 10. Risks and edge cases

- **Contrast of pins on a light map in dark mode.** Pins use `--primary` (brand,
  unchanged by theme) with a white border, so they stay legible. Worth one
  visual check on a network whose `--primary` is pale.
- **Cached CARTO tiles.** `cache-control: public,max-age=15552000` on the old
  tiles means a returning user may still see watermarked tiles from disk cache
  until the layer URL changes — which it does here, so a normal reload is
  enough. No cache-busting needed.
- **The notice is provider-scoped, not page-scoped.** A page that mounts two
  Leaflet maps at once would fire two effects; the stable toast `id` collapses
  them into one visible toast.
- **Nothing depends on `isDark` for the tile URL any more**, so a future dark
  basemap is a one-line change plus reverting the notice effect.

## 11. Verification (manual, chrome-devtools)

1. `pnpm dev:ui`, open `http://localhost:5173/`.
2. Light mode: map renders OSM, no watermark.
3. Toggle to dark (theme toggle, or
   `localStorage.setItem('dpg-theme-mode','dark')` + reload): app chrome goes
   dark, **map stays light**, notice toast appears top-center and dismisses
   itself after ~6 s.
4. Navigate away and back / maximize the map: no second toast.
5. In the console, confirm no tile request goes to `basemaps.cartocdn.com`:

   ```js
   [...document.querySelectorAll('.leaflet-tile')].map((t) => t.src)
   ```

   Every entry must be `tile.openstreetmap.org`, and
   `tiles.filter((t) => t.complete && t.naturalWidth === 0).length` must be `0`.
6. New tab → notice appears again once (session-scoped sentinel).


