# Location-source toggle — design

**Issue:** [Blue-Dots-Economy/signals-dpg#245](https://github.com/Blue-Dots-Economy/signals-dpg/issues/245)
**Date:** 2026-07-07
**Scope:** UI only (`apps/ui`). No API / back-end changes.

## Problem

The Browse map/list view sorts providers by distance and centers the map on a single
"nearby" anchor resolved by `useUserLocation` (`apps/ui/src/hooks/use-user-location.ts`,
consumed at `apps/ui/src/pages/home-page.tsx:423`). Today that anchor is fixed by priority:

1. the active profile's first `item_location`, if present — always wins;
2. else browser geolocation, auto-requested **once** (only when there is no profile location);
3. else `null` (default view).

Two gaps against issue #245:

- **No user override.** When a profile location exists, the user cannot choose to search
  around their *current* location instead — profile always wins, silently.
- **No "enable location" recovery in the main UI.** The `EnableLocationBanner` (a one-line
  "enable location" prompt with a CTA, plus a `blocked` state that points the user to their
  browser settings) exists only in the orange_dot onetac/tourist app
  (`apps/ui/src/tourist/`). The main Browse view auto-prompts once and then silently falls back.

## Goal

Let users switch the "nearby" anchor between **their profile location** and **their current
browser location**, and recover gracefully when browser permission is denied — reusing the
onetac enable-location pattern.

## Behavior

### The toggle

A labelled segmented control in the `ContentHeader`, right-aligned opposite the title/count,
via the header's existing `actions` slot (`home-page.tsx:1007`):

```
Providers                         Search near: [ 📍 My profile | 🧭 Current location ]
128 results near your profile
```

Built on the existing shadcn `ToggleGroup` (same primitive as the map/list toggle), as a small
`LocationSourceToggle` component.

### Visibility rule

Rendered **only when both**:

- the **active profile** (the one selected in the sidebar) has a location
  (`profileLocation != null`), and
- `navigator.geolocation` is supported (`useBrowserLocation().isSupported`).

Otherwise it is hidden — there is nothing to switch between (browser-only or default view).
Switching the active profile to one without a location hides the toggle again and the anchor
falls back to browser/none as it does today.

### Source selection & data flow

- New component state in `home-page.tsx`: `preferredSource: 'profile' | 'browser'`, default
  `'profile'`. **Not persisted** — resets to `'profile'` on reload / re-mount.
- `useUserLocation` gains a third argument `preferredSource` and honors it instead of the hard
  profile-first priority:
  - `'profile'` → use `profileLocation`.
  - `'browser'` → use browser location; if the browser status is `idle`, call `request()`.
  - When the preferred source yields no location, fall back to the other available source, else
    `null` (so behavior with no profile location is unchanged from today).
- The resolved `{ location, source }` continues to feed `sortByNearest` and map centering
  unchanged — nothing downstream needs to know about the toggle.

**Two distinct prompt triggers (do not conflate):**

1. **Auto-prompt (existing, unchanged):** on load the app requests browser location *only when
   there is no profile location*. This exists so a user who already has a profile location is
   not shown an unsolicited permission popup. It is not gated by the toggle.
2. **Explicit prompt on toggle switch (new):** when a profile location exists the toggle is
   shown, and clicking **🧭 Current location** calls `browser.request()` on that user gesture —
   the permission prompt appears then. This fires regardless of the profile location, because
   the user explicitly asked to search around their current location. If permission was
   previously denied/blocked, the enable-location banner's **Enable** button re-requests.

### Switch to browser + permission recovery

- Selecting `🧭 Current location` sets `preferredSource = 'browser'`. If location is not already
  resolved, `useUserLocation` fires `browser.request()`.
- If the browser status is `error` with a denied/blocked reason, render the shared
  `EnableLocationBanner` immediately below the `ContentHeader`:
  - **denied** (can re-prompt) → banner text + **Enable location** button that calls
    `browser.request()` again.
  - **blocked** (`permission_denied` and cannot re-prompt) → banner drops the button and shows
    the "enable location in your browser settings" text.
- Re-selecting `🧭 Current location` re-requests each time, unless hard-blocked.

## Components & changes

| File | Change |
| :-- | :-- |
| `apps/ui/src/hooks/use-user-location.ts` | Add `preferredSource` param; resolve by preferred source with fallback; keep the "auto-prompt once when no profile location" behavior for the default path. Update the doc comment. |
| `apps/ui/src/components/location/location-source-toggle.tsx` (new) | Small presentational `ToggleGroup`: `value`, `onChange`, `profileLabel`. |
| `apps/ui/src/components/location/enable-location-banner.tsx` (moved) | Promote `apps/ui/src/tourist/enable-location-banner.tsx` to a shared location; unchanged props (`onEnable`, `blocked`). |
| `apps/ui/src/tourist/tourist-app.tsx` | Update import to the moved banner. |
| `apps/ui/src/pages/home-page.tsx` | Add `preferredSource` state; pass it to `useUserLocation`; render `LocationSourceToggle` in `ContentHeader` `actions` (gated by the visibility rule); render `EnableLocationBanner` when browser is chosen and denied/blocked. |
| `apps/ui/src/i18n/locales/*` | Add `home.search_near_label`, `home.search_near_profile`, `home.search_near_browser`; reuse existing `tourist.enable_location_*` keys for the banner. |

The `ContentHeader` `actions` slot already renders a `list`-view-only Select button; the toggle
composes alongside it (both can show in list view; the toggle also shows in map view).

## Testing

- `use-user-location.test.ts`: source resolution for each `preferredSource` — profile chosen
  with a location; browser chosen (requests when idle); browser chosen but denied → fallback;
  no profile location → unchanged auto-prompt path.
- `location-source-toggle` component test: visibility rule (hidden when no profile location or
  geolocation unsupported); selecting `browser` invokes `onChange`.
- Home-page integration (existing test harness): banner appears when browser is selected and the
  browser hook reports denied/blocked.

## Out of scope

- No back-end / API changes.
- No change to the tourist/onetac flow beyond the shared-banner import move.
- No persistence of the source choice.
