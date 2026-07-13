# PII location jitter — design

**Date:** 2026-07-07
**Status:** Draft for review
**Issue:** signals-dpg #243
**Scope:** `signals-dpg` (api + ui + config)

## Motivation

Profiles whose primary location field is marked `"private": true` (PII) are
currently geotagged at **city level**: the address is geocoded, its city
component is read, and that city is re-geocoded to its centroid. This is too
coarse — every private profile in a city collapses onto one point, so
distance/nearest-first features are meaningless within a city.

We want private locations stored as a **randomised point within a configurable
100–250 m annulus of the true location**: precise enough to be useful for
proximity, imprecise enough that the exact address is never recoverable.

## Current behaviour (what exists today)

The PII coarsening rule is implemented **twice**, and there is a server geocode
step that returns a city centroid:

1. **Server, geocode path** — `resolveCityCenter` (`apps/api/src/services/geocoding/geo_resolver.ts`):
   address → exact point → read city component → re-geocode city → centroid
   (fallback: exact point rounded to ~1 km). Invoked from the private branch of
   `geocodeLocationsFromState` (`resolve_locations_for_create.ts`).
2. **Server, storage path** — `coarsenPrivateLocations` / `locationsForStorage`
   (`apps/api/src/services/item_service.ts`): rounds any stored coordinate to
   ~1 km (2 decimals). Sits on **every** write via `createItemInternal` and
   `updateItemInternal`.
3. **Browser** — `coarsenPlace` (`apps/ui/src/pages/profile-form-page.tsx`)
   reimplements the same "resolve city centroid / ~1 km fallback" rule client-side,
   so the exact point never leaves the browser; it sends the centroid as
   `item_locations`.

All four write surfaces share the server pipeline:

```
/item/create ─────────────┐
/admin/participant create ─┼→ resolveLocationsForCreate → geocodeLocationsFromState ┐
  (create_profile_item)    │                                                         ├→ createItemInternal
/item/update ──────────────┼→ updateItemInternal → (geocodeLocationsFromState) ──────┘   └ locationsForStorage
/admin/participant update ─┘      (address-changed branch)          └ locationsForStorage
```

Shared field-selection helpers (`parseLocationFields`, `buildLocationQueries`,
`isLocationFieldPrivate`) live in `@dpg/schemas` and are reused by both server
and browser — those stay unchanged.

**Networks affected** (private primary location): `blue_dot` seeker (`location`),
`yellow_dot`, `purple_dot` seeker (`address`). Public primary locations
(`blue_dot` Job Location, `purple_dot` `service_cities`, `orange_dot` `area`)
are geocoded to their **exact** point today and are **unaffected**.

## Goal

- Private primary location → a deterministic random point in a configurable
  100–250 m annulus of the true location.
- **One** PII transform (the jitter), applied **once**, server-side, at the
  storage choke point.
- Collapse the duplicated coarsening rule: delete the browser's `coarsenPlace`
  private branch and the server's `resolveCityCenter` + `geocodeLocationsFromState`
  private branch.
- No behaviour change for public location fields.

## Design decisions

These were settled during brainstorming:

| Decision | Choice |
|---|---|
| Jitter stability | **Deterministic** — same true location always yields the same jittered point (seeded RNG). Prevents averaging multiple snapshots back to the truth. |
| Radius config granularity | **Global env vars** (`PII_LOCATION_JITTER_MIN_METERS` / `_MAX_METERS`). |
| Which coarsening paths | **Both** unify to the single jitter. |
| Coordinate authority | **Server jitters received coordinates.** Browser sends the exact coord it already holds from autocomplete; server jitters before storing. |
| Drift handling | **Determinism + skip-if-identical**, no bypass flag (a flag would let a client persist an exact PII coordinate). |

### Why server-side jitter on received coordinates

Google Places autocomplete already returns exact `lat`/`lng` in the same flow
(`google-places.ts` `fetchFields({ fields: ['location', ...] })`), so the browser
sends the exact coord with no extra call. The server is the single place that
applies the jitter, so **every** path — browser-provided, bot-geocoded,
update-geocoded — is covered by one function and a client cannot bypass it.

### Privacy posture change (accepted)

Today the exact point never leaves the browser. Under this design the exact
coordinate travels to the server (over TLS) for private fields and lives in
memory until jittered. The delta is small — the address string already travels
to the server and is stored encrypted, so the server can derive the exact point
regardless. Requirements that follow:

- The exact coordinate and the address must **not** be logged.
- Jitter is applied **before** the coordinate is persisted or returned in any
  response.
- `item_locations` remains stored unencrypted, so the jitter is the sole barrier
  — it must be unconditional for private fields (no opt-out).

## The jitter

Pure function, no new dependency (plain `Math`):

```
jitter(coord, minM, maxM) -> coord'
  seed  = hash("lat.rounded5,lng.rounded5")     // deterministic per true point
  (u, v) = twoUniformsFrom(seed)                 // mulberry32 or equivalent
  // uniform over the annulus area, not biased toward the inner radius:
  dist  = sqrt(u * (maxM^2 - minM^2) + minM^2)   // metres, in [minM, maxM]
  theta = 2π * v                                 // bearing
  dLat  = (dist * cos(theta)) / 111_320
  dLng  = (dist * sin(theta)) / (111_320 * cos(latRad))
  return { lat: coord.lat + dLat, lng: coord.lng + dLng, label? }
```

- **Deterministic**: seeded from the exact coord rounded to 5 decimals (~1 m
  grid), so the same address (browser re-geocode, or bot re-send) always yields
  the same jittered point → stable across saves, no drift on the normal paths.
- **Uniform in the annulus** so the point isn't clustered at the inner radius.
- **Label** (place/city name) is preserved unchanged if present.

## Changes

### Config (`packages/config/src/secrets.ts`, `apps/api/src/config.ts`, `turbo.json`)

- Add `PII_LOCATION_JITTER_MIN_METERS` (default 100) and
  `PII_LOCATION_JITTER_MAX_METERS` (default 250) to the Zod env schema
  (coerced numbers, `min < max` refinement).
- Expose via a `piiLocationConfig` (or extend `geocodingConfig`).
- Add both names to `turbo.json` `globalPassThroughEnv`.

### Server geocode path (`geo_resolver.ts`, `resolve_locations_for_create.ts`)

- **Delete `resolveCityCenter`** and its helpers that are only used for the
  city-centroid step (`resolveDetailed`, `parse*Detailed`, `roundCoord` if
  unused elsewhere).
- In `geocodeLocationsFromState`, remove the `isLocationFieldPrivate` branch —
  always resolve the primary field to its **exact** coordinate via
  `resolveCoordinates` (same as the public path). Privacy is applied downstream
  by the storage-layer jitter.

### Server storage choke point (`item_service.ts`)

- Replace `coarsenPrivateLocations` (round to 2 decimals) with
  `jitterPrivateLocations`: for a private primary field, map each location
  through `jitter(coord, minM, maxM)`; non-private fields returned unchanged.
- `locationsForStorage` calls `jitterPrivateLocations`.
- **Create**: always jitter provided/geocoded coords for private fields
  (an exact coord supplied on create is never persisted).
- **Update** (`updateItemInternal`, existing precedence at the provided-coords /
  address-changed branches):
  - provided `item_locations` **identical to currently-stored** → skip jitter,
    leave as-is (drift guard for read-modify-write clients).
  - provided `item_locations` differ, or address changed → jitter.
  - location not in payload → coords untouched (unchanged today).

### Browser (`profile-form-page.tsx`, `location-autocomplete-widget.tsx`)

- Remove the `coarsenPlace` **private** branch: for a private primary field the
  UI sends the **exact** picked/geocoded coordinate (public behaviour is already
  exact, so `coarsenPlace` collapses to "pass through").
- No change to autocomplete transport or the widget's coordinate capture.
- The map pin after save reflects the server's returned jittered point.

## Edge cases & non-goals

- **Geocode failure** stays best-effort: no coordinate stored (unchanged).
- **Existing data**: profiles already stored at city-centroid are not migrated;
  they update to a jittered point on their next write. Backfill is out of scope.
- **orange_dot `latitude`/`longitude`** dead schema fields: known, **out of scope**
  for this spec.
- **Public location fields**: unchanged (exact).
- **No bypass flag** for jitter.

## Testing

- **Unit — `jitter`**: distance from origin always in `[minM, maxM]`; determinism
  (same input → identical output); annulus uniformity (statistical, seeded inputs);
  correct metre→degree conversion at non-equatorial latitudes.
- **Unit — `jitterPrivateLocations`**: private field jittered, public field
  untouched, empty input, label preserved.
- **Unit — storage/update**: create jitters provided exact coord; update with
  identical-to-stored coords skips (no drift); update with changed address
  re-geocodes exact + jitters; update not touching location leaves coords.
- **Unit — `geocodeLocationsFromState`**: private and public both resolve to
  exact (no city-centroid path remains).
- **Config**: `min < max` refinement rejects bad env.
- Remove/replace tests asserting the old city-centroid / 2-decimal rounding
  behaviour (`geo_resolver.test.ts`, create/update tests).
