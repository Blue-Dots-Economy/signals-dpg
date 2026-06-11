# Changelog

Notable changes to Signals-DPG. Entries are grouped per `feature → develop`
sync; newest first. PR numbers link the detail.

## 2026-06-11 — feature → develop sync (#128)

44 commits since the previous sync (#63, Jun 4).

### Participant onboarding lifecycle

- Account/profile split with lifecycle gates: items classify `draft` → `live`
  on create/update via a pure lifecycle classifier; `/network/item/fetch`
  returns live-only items; action perform/update-status and PII reveal are
  blocked unless both endpoints are live; `POST /item/lifecycle`
  (pause/unpause); pending actions auto-cancel when an item leaves live;
  backfill script included. (#104)
- Live latch: required fields cannot be cleared once an item is live;
  destructive action cancellation dropped. (#115)
- Read-only `GET /admin/participant` — account-only + `owned_elsewhere` +
  aggregator-scoped writes. (#113)

### Location & geotagging

- Config-driven geotagging with address autocomplete (Google Places + Photon
  fallback). (#103)
- Multi-location items + city-level geocoding for PII addresses. (#112)
- Location-aware "nearby items" via browser geolocation; orange_dot
  restricted to practitioner-only. (#123)
- orange_dot tourist discovery UI: login-free map of nearby practitioners +
  single-image deploy switch. (#130)

### Metrics & aggregator

- User-level metrics + directional (initiated/received) action maps in the
  aggregator dashboard rollup. (#122)
- Aggregator dashboard/export now decrypt private display names (fixes
  participant names showing as UUIDs — aggregator-dpg#406). Resolution is
  restricted to schema fields marked `private: true`, scoped to the
  `onboarded_by_org_id` entitlement, and degrades to the precomputed name on
  any failure — never 500s the read or truncates the export. (#127)

### Schemas & config

- Provider→provider connect interaction (blue_dot, purple_dot). (#74)
- Single-domain lock, derived from items — no schema change. (#75)
- blue_dot network.json: jobstack-derived fields. (#129)
- `dashboard_tiles.user` gains the `avg_actions_per_user` tile on all
  networks; the two avg tiles standardise on "Avg Profiles per User" /
  "Avg Actions per User" while `total_users` keeps network-specific
  labels. (#131)

### Fixes & chores

- Auth UI: phone numbers normalised and validated before OTP send. (#70)
- LICENSE copyright updated to Blue Dots Economy. (#126)
- Vitest setup stubs required env vars so API unit tests run without a
  local `.env`.

## 2026-06-04 — feature → develop sync (#63)

Bulk actions, map enhancements, Orange Dot seeding & OneTAC branding,
config-driven item cards, runtime `/config.js` loading, Browse domains
derived from interaction `to_domains`. (Pre-changelog; see #63 for detail.)
