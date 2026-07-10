# Location-source toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Browse users switch the "nearby" anchor between their profile location and their current browser location, with a permission-recovery banner, on the Signals main UI.

**Architecture:** A presentational `LocationSourceToggle` in the `ContentHeader` drives a `preferredSource` state in `home-page.tsx`. `useUserLocation` is extended to honor that preference (falling back to whatever location is available) and to expose the underlying browser hook so the page can request permission and render the shared `EnableLocationBanner`. The banner and the geolocation-permission tracking are promoted out of `tourist/` into shared locations so the main UI and the onetac UI use one implementation.

**Tech Stack:** React 19, TypeScript (strict, ESM, no `any`), Vite, Vitest + @testing-library/react (happy-dom), radix `ToggleGroup`, react-i18next, lucide-react icons.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-07-location-source-toggle-design.md`. Every task's requirements implicitly include the spec.
- **UI only.** No API / back-end / schema changes.
- **File naming:** kebab-case filenames (e.g. `location-source-toggle.tsx`), PascalCase components, camelCase hooks. Match surrounding code.
- **No persistence** of the source choice — component state only, default `'profile'`.
- **i18n:** every new UI string key MUST be added to all three locales: `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`. Reuse existing `tourist.enable_location_*` keys for the banner (do not duplicate them).
- **Commits:** this environment signs commits with an SSH key that needs an interactive passphrase, so use `git -c commit.gpgsign=false commit ...` for every commit. A husky/lint-staged pre-commit hook runs prettier on staged files — expected.
- **Test command (all):** `pnpm --filter ui test`. **Single file:** `pnpm --filter ui exec vitest run <path>`. **Typecheck:** `pnpm --filter ui exec tsc --noEmit`.
- Branch: `feat/location-source-toggle` (already created off `feature`).

## File Structure

- `apps/ui/src/components/location/enable-location-banner.tsx` — shared banner (moved from `tourist/`).
- `apps/ui/src/components/location/enable-location-banner.test.tsx` — moved test.
- `apps/ui/src/components/location/location-source-toggle.tsx` — new presentational toggle.
- `apps/ui/src/components/location/location-source-toggle.test.tsx` — new test.
- `apps/ui/src/hooks/use-geolocation-permission.ts` — new hook (extracted from tourist-app).
- `apps/ui/src/hooks/__tests__/use-geolocation-permission.test.ts` — new test.
- `apps/ui/src/hooks/use-user-location.ts` — extended with `preferredSource`; returns `browser`.
- `apps/ui/src/hooks/__tests__/use-user-location.test.ts` — new test.
- `apps/ui/src/tourist/tourist-app.tsx` — use moved banner + extracted permission hook.
- `apps/ui/src/pages/home-page.tsx` — wire state, toggle, banner.
- `apps/ui/src/i18n/locales/{en,hi,kn}.json` — three new `home.search_near_*` keys each.

---

### Task 1: Promote `EnableLocationBanner` to a shared component

**Files:**
- Move: `apps/ui/src/tourist/enable-location-banner.tsx` → `apps/ui/src/components/location/enable-location-banner.tsx`
- Move: `apps/ui/src/tourist/enable-location-banner.test.tsx` → `apps/ui/src/components/location/enable-location-banner.test.tsx`
- Modify: `apps/ui/src/tourist/tourist-app.tsx` (banner import)

**Interfaces:**
- Produces: `EnableLocationBanner({ onEnable: () => void, blocked?: boolean })` at `@/components/location/enable-location-banner`. Behavior unchanged.

- [ ] **Step 1: Move the banner and its test with git (preserves history; both use relative `./enable-location-banner`, so the test import needs no change)**

```bash
cd /Users/srivastha/KKB/Github/signals-dpg
mkdir -p apps/ui/src/components/location
git mv apps/ui/src/tourist/enable-location-banner.tsx apps/ui/src/components/location/enable-location-banner.tsx
git mv apps/ui/src/tourist/enable-location-banner.test.tsx apps/ui/src/components/location/enable-location-banner.test.tsx
```

- [ ] **Step 2: Update the import in `tourist-app.tsx`**

Find:
```tsx
import { EnableLocationBanner } from './enable-location-banner';
```
Replace with:
```tsx
import { EnableLocationBanner } from '@/components/location/enable-location-banner';
```

- [ ] **Step 3: Run the moved test to verify it still passes**

Run: `pnpm --filter ui exec vitest run src/components/location/enable-location-banner.test.tsx`
Expected: PASS (1 test).

- [ ] **Step 4: Typecheck to confirm no dangling import**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "refactor(ui): move EnableLocationBanner to shared components/location"
```

---

### Task 2: Extract `useGeolocationPermission` hook

The `blocked` state (truly-denied vs merely-dismissed) is derived from the Permissions API — currently inline in `tourist-app.tsx`. Extract it so both the tourist UI and the home page share one implementation.

**Files:**
- Create: `apps/ui/src/hooks/use-geolocation-permission.ts`
- Create: `apps/ui/src/hooks/__tests__/use-geolocation-permission.test.ts`
- Modify: `apps/ui/src/tourist/tourist-app.tsx` (replace inline permission tracking)

**Interfaces:**
- Produces: `useGeolocationPermission(): PermissionState | 'unknown'` at `@/hooks/use-geolocation-permission`. `'denied'` means the site is truly blocked; `'unknown'` when the Permissions API is unavailable.

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/hooks/__tests__/use-geolocation-permission.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGeolocationPermission } from '../use-geolocation-permission';

afterEach(() => {
  // Restore a clean navigator.permissions between tests.
  Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
});

describe('useGeolocationPermission', () => {
  it('reflects the resolved permission state', async () => {
    const query = vi.fn().mockResolvedValue({
      state: 'denied' as PermissionState,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    Object.defineProperty(navigator, 'permissions', { value: { query }, configurable: true });

    const { result } = renderHook(() => useGeolocationPermission());
    await waitFor(() => expect(result.current).toBe('denied'));
  });

  it("returns 'unknown' when the Permissions API is unavailable", () => {
    Object.defineProperty(navigator, 'permissions', { value: undefined, configurable: true });
    const { result } = renderHook(() => useGeolocationPermission());
    expect(result.current).toBe('unknown');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-geolocation-permission.test.ts`
Expected: FAIL — cannot resolve `../use-geolocation-permission`.

- [ ] **Step 3: Write the hook**

Create `apps/ui/src/hooks/use-geolocation-permission.ts`:
```ts
import * as React from 'react';

/**
 * Tracks the browser's geolocation PERMISSION state via the Permissions API.
 *
 * The geolocation error code is PERMISSION_DENIED for both a real "block" and a
 * merely-dismissed prompt, so it can't distinguish them. The Permissions API
 * can: it reports 'denied' only on a real block and stays 'prompt' when
 * dismissed. Use 'denied' to decide when re-prompting is futile (hide the
 * "Enable location" button and point the user to browser settings instead).
 *
 * Returns 'unknown' when the Permissions API is unavailable (SSR / older
 * browsers) — callers should treat 'unknown' as "not known to be blocked".
 */
export function useGeolocationPermission(): PermissionState | 'unknown' {
  const [state, setState] = React.useState<PermissionState | 'unknown'>('unknown');

  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    const onChange = () => setState(status?.state ?? 'unknown');
    navigator.permissions
      .query({ name: 'geolocation' as PermissionName })
      .then((s) => {
        status = s;
        setState(s.state);
        s.addEventListener('change', onChange);
      })
      .catch(() => setState('unknown'));
    return () => status?.removeEventListener('change', onChange);
  }, []);

  return state;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-geolocation-permission.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Refactor `tourist-app.tsx` to use the hook**

In `apps/ui/src/tourist/tourist-app.tsx`, add the import alongside the other hook imports:
```tsx
import { useGeolocationPermission } from '@/hooks/use-geolocation-permission';
```

Delete the inline permission-tracking block (the `geoPermission` state and its `React.useEffect` that calls `navigator.permissions.query`, including the explanatory comment above it) and replace the whole block with a single line:
```tsx
const geoPermission = useGeolocationPermission();
```
Leave every existing use of `geoPermission` (e.g. `blocked={geoPermission === 'denied'}`) unchanged.

- [ ] **Step 6: Run the tourist tests + typecheck to confirm no behavior change**

Run: `pnpm --filter ui exec vitest run src/tourist`
Expected: PASS (all existing tourist tests).
Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "refactor(ui): extract useGeolocationPermission hook, reuse in tourist"
```

---

### Task 3: Extend `useUserLocation` with a preferred source

**Files:**
- Modify: `apps/ui/src/hooks/use-user-location.ts`
- Create: `apps/ui/src/hooks/__tests__/use-user-location.test.ts`

**Interfaces:**
- Consumes: `useBrowserLocation()` → `UseBrowserLocationReturn` (`{ location, status, error, isSupported, request, reset }`) from `@/hooks/use-browser-location`.
- Produces:
  - `type PreferredLocationSource = 'profile' | 'browser'`
  - `useUserLocation(profileLocation: LatLng | null, profileResolved: boolean, preferredSource?: PreferredLocationSource): ResolvedUserLocation`
  - `interface ResolvedUserLocation { location: LatLng | null; source: 'profile' | 'browser' | 'none'; browser: UseBrowserLocationReturn }`

- [ ] **Step 1: Write the failing test**

Create `apps/ui/src/hooks/__tests__/use-user-location.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const mockBrowser = vi.hoisted(() => ({
  location: null as { lat: number; lng: number; accuracy: number } | null,
  status: 'idle' as 'idle' | 'loading' | 'success' | 'error',
  error: null,
  isSupported: true,
  request: vi.fn(() => Promise.resolve(null)),
  reset: vi.fn(),
}));

vi.mock('@/hooks/use-browser-location', () => ({
  useBrowserLocation: () => mockBrowser,
}));

import { useUserLocation } from '../use-user-location';

const PROFILE = { lat: 22.3, lng: 70.8 };
const BROWSER = { lat: 23.0, lng: 72.6, accuracy: 20 };

beforeEach(() => {
  mockBrowser.location = null;
  mockBrowser.status = 'idle';
  mockBrowser.request.mockClear();
});

describe('useUserLocation', () => {
  it("prefers the profile location when preferredSource is 'profile'", () => {
    mockBrowser.location = BROWSER;
    mockBrowser.status = 'success';
    const { result } = renderHook(() => useUserLocation(PROFILE, true, 'profile'));
    expect(result.current.location).toEqual(PROFILE);
    expect(result.current.source).toBe('profile');
  });

  it("uses the browser location when preferredSource is 'browser'", () => {
    mockBrowser.location = BROWSER;
    mockBrowser.status = 'success';
    const { result } = renderHook(() => useUserLocation(PROFILE, true, 'browser'));
    expect(result.current.location).toEqual({ lat: BROWSER.lat, lng: BROWSER.lng });
    expect(result.current.source).toBe('browser');
  });

  it("falls back to the profile location when browser is preferred but unavailable", () => {
    mockBrowser.location = null;
    mockBrowser.status = 'error';
    const { result } = renderHook(() => useUserLocation(PROFILE, true, 'browser'));
    expect(result.current.location).toEqual(PROFILE);
    expect(result.current.source).toBe('profile');
  });

  it('auto-requests the browser location when there is no profile location', () => {
    renderHook(() => useUserLocation(null, true, 'profile'));
    expect(mockBrowser.request).toHaveBeenCalled();
  });

  it('requests the browser location when browser is explicitly preferred and idle', () => {
    renderHook(() => useUserLocation(PROFILE, true, 'browser'));
    expect(mockBrowser.request).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-user-location.test.ts`
Expected: FAIL — `useUserLocation` does not accept a third argument / does not return the expected source for `'browser'`.

- [ ] **Step 3: Rewrite `use-user-location.ts`**

Replace the entire contents of `apps/ui/src/hooks/use-user-location.ts` with:
```ts
import * as React from 'react';
import {
  useBrowserLocation,
  type UseBrowserLocationReturn,
} from '@/hooks/use-browser-location';
import type { LatLng } from '@/lib/geo/types';

export type UserLocationSource = 'profile' | 'browser' | 'none';

/** The location source a user can explicitly ask for via the toggle. */
export type PreferredLocationSource = 'profile' | 'browser';

export interface ResolvedUserLocation {
  location: LatLng | null;
  source: UserLocationSource;
  /** The underlying browser-location hook, so callers can drive permission UI. */
  browser: UseBrowserLocationReturn;
}

/**
 * Resolves the location used for "nearby" features.
 *
 * `preferredSource` is the user's explicit choice (default 'profile'):
 *  - 'profile' → the active profile's location, falling back to the browser
 *    location when the profile has none.
 *  - 'browser' → the browser geolocation, falling back to the profile location
 *    when the browser one isn't available (denied / not yet resolved).
 *
 * Two prompt triggers:
 *  1. Auto-prompt (unchanged): when there is NO profile location, the browser
 *     location is auto-requested once so a visitor / location-less profile still
 *     gets nearby results without an explicit action.
 *  2. Explicit prompt: when 'browser' is preferred and the browser status is
 *     idle, request it — this fires from the toggle's user gesture even when a
 *     profile location exists.
 *
 * `profileResolved` gates the auto-prompt so a logged-in user with a profile
 * location isn't prompted during the async profile-load window.
 */
export function useUserLocation(
  profileLocation: LatLng | null,
  profileResolved: boolean,
  preferredSource: PreferredLocationSource = 'profile',
): ResolvedUserLocation {
  const browser = useBrowserLocation();

  const wantsBrowser =
    preferredSource === 'browser' || (profileResolved && !profileLocation);

  React.useEffect(() => {
    if (wantsBrowser && browser.isSupported && browser.status === 'idle') {
      // Errors surface via browser.status / browser.error; void is intentional.
      void browser.request();
    }
  }, [wantsBrowser, browser.isSupported, browser.status, browser.request]);

  const browserLatLng: LatLng | null = browser.location
    ? { lat: browser.location.lat, lng: browser.location.lng }
    : null;

  let location: LatLng | null;
  let source: UserLocationSource;
  if (preferredSource === 'browser') {
    location = browserLatLng ?? profileLocation;
    source = browserLatLng ? 'browser' : profileLocation ? 'profile' : 'none';
  } else {
    location = profileLocation ?? browserLatLng;
    source = profileLocation ? 'profile' : browserLatLng ? 'browser' : 'none';
  }

  return { location, source, browser };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/hooks/__tests__/use-user-location.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "feat(ui): useUserLocation honors a preferred location source"
```

---

### Task 4: `LocationSourceToggle` component + i18n

**Files:**
- Create: `apps/ui/src/components/location/location-source-toggle.tsx`
- Create: `apps/ui/src/components/location/location-source-toggle.test.tsx`
- Modify: `apps/ui/src/i18n/locales/en.json`, `hi.json`, `kn.json`

**Interfaces:**
- Consumes: `PreferredLocationSource` from `@/hooks/use-user-location`; `ToggleGroup`, `ToggleGroupItem` from `@/components/ui/toggle-group`.
- Produces: `LocationSourceToggle({ value: PreferredLocationSource, onChange: (v: PreferredLocationSource) => void })` at `@/components/location/location-source-toggle`.

- [ ] **Step 1: Add the i18n keys** (all three locales)

In `apps/ui/src/i18n/locales/en.json`, add:
```json
  "home.search_near_label": "Search near",
  "home.search_near_profile": "My profile",
  "home.search_near_browser": "Current location",
```
In `apps/ui/src/i18n/locales/hi.json`, add:
```json
  "home.search_near_label": "आस-पास खोजें",
  "home.search_near_profile": "मेरी प्रोफ़ाइल",
  "home.search_near_browser": "वर्तमान स्थान",
```
In `apps/ui/src/i18n/locales/kn.json`, add:
```json
  "home.search_near_label": "ಹತ್ತಿರ ಹುಡುಕಿ",
  "home.search_near_profile": "ನನ್ನ ಪ್ರೊಫೈಲ್",
  "home.search_near_browser": "ಪ್ರಸ್ತುತ ಸ್ಥಳ",
```
(Insert each as valid JSON entries — mind trailing commas.)

- [ ] **Step 2: Write the failing test**

Create `apps/ui/src/components/location/location-source-toggle.test.tsx`:
```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LocationSourceToggle } from './location-source-toggle';

describe('LocationSourceToggle', () => {
  it('renders both source options', () => {
    render(<LocationSourceToggle value="profile" onChange={vi.fn()} />);
    expect(screen.getByRole('button', { name: /my profile/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /current location/i })).toBeInTheDocument();
  });

  it('calls onChange with the picked source', async () => {
    const onChange = vi.fn();
    render(<LocationSourceToggle value="profile" onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /current location/i }));
    expect(onChange).toHaveBeenCalledWith('browser');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm --filter ui exec vitest run src/components/location/location-source-toggle.test.tsx`
Expected: FAIL — cannot resolve `./location-source-toggle`.

- [ ] **Step 4: Write the component**

Create `apps/ui/src/components/location/location-source-toggle.tsx`:
```tsx
import { MapPin, Navigation } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import type { PreferredLocationSource } from '@/hooks/use-user-location';

export interface LocationSourceToggleProps {
  value: PreferredLocationSource;
  onChange: (value: PreferredLocationSource) => void;
}

/**
 * Switches the "nearby" anchor between the active profile's location and the
 * browser's current location. Render only when a profile location exists and
 * geolocation is supported (the caller owns that visibility rule).
 */
export function LocationSourceToggle({ value, onChange }: LocationSourceToggleProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <span className="hidden text-sm text-muted-foreground sm:inline">
        {t('home.search_near_label')}
      </span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(next) => {
          if (next === 'profile' || next === 'browser') onChange(next);
        }}
        variant="outline"
        size="sm"
      >
        <ToggleGroupItem value="profile" aria-label={t('home.search_near_profile')}>
          <MapPin className="mr-1.5 h-4 w-4" />
          <span className="hidden sm:inline">{t('home.search_near_profile')}</span>
        </ToggleGroupItem>
        <ToggleGroupItem value="browser" aria-label={t('home.search_near_browser')}>
          <Navigation className="mr-1.5 h-4 w-4" />
          <span className="hidden sm:inline">{t('home.search_near_browser')}</span>
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter ui exec vitest run src/components/location/location-source-toggle.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "feat(ui): add LocationSourceToggle component + i18n keys"
```

---

### Task 5: Wire the toggle and banner into `home-page.tsx`

**Files:**
- Modify: `apps/ui/src/pages/home-page.tsx`

**Interfaces:**
- Consumes: `useUserLocation(profileLocation, profilesResolved, preferredSource)` → `{ location, browser }`; `useGeolocationPermission()`; `LocationSourceToggle`; `EnableLocationBanner`; `PreferredLocationSource`.

- [ ] **Step 1: Add imports** (with the other `@/components` / `@/hooks` imports near the top)

```tsx
import { LocationSourceToggle } from '@/components/location/location-source-toggle';
import { EnableLocationBanner } from '@/components/location/enable-location-banner';
import { useGeolocationPermission } from '@/hooks/use-geolocation-permission';
import type { PreferredLocationSource } from '@/hooks/use-user-location';
```

- [ ] **Step 2: Add source state + expand the location resolution**

Replace this line (currently `home-page.tsx:423`):
```tsx
  const { location: userLocation } = useUserLocation(profileLocation, profilesResolved);
```
with:
```tsx
  const [preferredSource, setPreferredSource] =
    React.useState<PreferredLocationSource>('profile');

  const { location: userLocation, browser: browserLocation } = useUserLocation(
    profileLocation,
    profilesResolved,
    preferredSource,
  );
  const geoPermission = useGeolocationPermission();

  // The toggle only makes sense when there's a profile location to switch away
  // from and the browser can actually provide the alternative.
  const canToggleLocation = Boolean(profileLocation) && browserLocation.isSupported;

  // When the user picked "current location" but the browser request errored
  // (denied / unavailable), offer to enable it.
  const showLocationBanner =
    preferredSource === 'browser' && browserLocation.status === 'error';

  const handleLocationSourceChange = React.useCallback(
    (next: PreferredLocationSource) => setPreferredSource(next),
    [],
  );
```

- [ ] **Step 3: Compose the header actions** (toggle + existing select button)

Replace the `ContentHeader`'s `actions={...}` prop (currently `home-page.tsx:1012-1028`, the `myItem && viewMode === 'list' ? (<Button …Select…/>) : undefined` expression) with `actions={headerActions}`, and define `headerActions` just before the `return (` of the component's JSX (near `const filtersPanel = (` at `home-page.tsx:973`):
```tsx
  const selectButton =
    myItem && viewMode === 'list' ? (
      <Button
        type="button"
        variant={browseSelection.selectMode ? 'default' : 'outline'}
        size="sm"
        onClick={() =>
          browseSelection.selectMode
            ? browseSelection.exitSelect()
            : browseSelection.enterSelect()
        }
      >
        <CheckSquare className="mr-1.5 h-4 w-4" />
        {browseSelection.selectMode ? t('selection.done') : t('selection.select')}
      </Button>
    ) : null;

  const headerActions =
    canToggleLocation || selectButton ? (
      <div className="flex items-center gap-2">
        {canToggleLocation && (
          <LocationSourceToggle
            value={preferredSource}
            onChange={handleLocationSourceChange}
          />
        )}
        {selectButton}
      </div>
    ) : undefined;
```

- [ ] **Step 4: Render the banner** below the header

Immediately after the `{!user ? (<GuestHero />) : (<ContentHeader … />)}` block and before `<ActionHandler` (currently `home-page.tsx:1031`), insert:
```tsx
      {showLocationBanner && (
        <EnableLocationBanner
          onEnable={() => void browserLocation.request()}
          blocked={geoPermission === 'denied'}
        />
      )}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter ui exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the full UI test suite** (no regressions)

Run: `pnpm --filter ui test`
Expected: PASS, including the new banner/toggle/hook tests.

- [ ] **Step 7: Manual smoke test** (drive the real UI)

Start the app (`pnpm --filter ui dev`, or use the `run-signals-dpg` skill) and, signed in as a user whose active profile has a location, verify:
1. The `Search near [My profile | Current location]` toggle appears in the content header (both map and list view).
2. Selecting **Current location** triggers the browser permission prompt; on allow, the list re-sorts / map re-centers around the current location.
3. Denying permission shows the enable-location banner with an **Enable location** button that re-prompts; after blocking in the browser, the banner drops the button and shows the "enable in browser settings" text.
4. Switching the active profile to one **without** a location (or signing out) hides the toggle.

- [ ] **Step 8: Commit**

```bash
git add -A
git -c commit.gpgsign=false commit -m "feat(ui): profile/current location toggle + enable-location banner on Browse (#245)"
```

---

## Self-Review

**Spec coverage:**
- Toggle in ContentHeader (placement C) → Task 4 (component) + Task 5 Step 3.
- Visibility rule (active profile has location + geolocation supported) → Task 5 Step 2 (`canToggleLocation`).
- `preferredSource` state, default profile, not persisted → Task 5 Step 2.
- `useUserLocation` honors preferred source with fallback → Task 3.
- Two prompt triggers (auto when no profile location; explicit on switch) → Task 3 (`wantsBrowser` + effect).
- Enable-location banner shared, denied/blocked states → Task 1 (move) + Task 2 (permission hook) + Task 5 Step 4.
- Tourist import/refactor updated → Task 1 Step 2, Task 2 Step 5.
- i18n keys in all locales, reuse tourist banner keys → Task 4 Step 1.
- Tests (hook resolution, toggle visibility/onChange, banner) → Tasks 2, 3, 4; integration smoke → Task 5 Step 7.
- No API/back-end changes → nothing in the plan touches `apps/api` or `packages`.

**Placeholder scan:** none — every code and command step is concrete.

**Type consistency:** `PreferredLocationSource` defined in Task 3 (`use-user-location.ts`), consumed identically in Task 4 (component) and Task 5 (page). `useUserLocation` returns `{ location, source, browser }` in Task 3 and is destructured as `{ location, browser }` in Task 5. `EnableLocationBanner({ onEnable, blocked })` unchanged from Task 1 and used with those exact props in Task 5. `useGeolocationPermission()` returns `PermissionState | 'unknown'` in Task 2, compared to `'denied'` in Task 5.
