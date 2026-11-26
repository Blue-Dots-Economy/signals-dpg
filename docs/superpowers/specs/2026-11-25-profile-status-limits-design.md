# Profile limits by status (#927) — design

Scope: Signals API. UI is under separate review. Part of #836.

## Rule

Two limits per account, per network + domain + item type (same scope as today):

| Limit | Counts         | blue_dot providers |
|-------|----------------|--------------------|
| live  | live           | 200                |
| total | live + draft + paused | 300         |

- Retired counts toward nothing.
- An account can hold up to 200 live, or up to 300 drafts, or any mix within both limits.
- Pause never changes the total, so it is always allowed.

## Config (`network.json`, per domain)

```json
"profile_limits": { "live": 200, "total": 300 }
```

- Optional. Schema change in `packages/schemas/src/network_workflow.ts`; `live` must be ≤ `total`.
- Domain without it: no live limit; total limit is `MAX_PROFILES_PER_USER` (env, default 5), as today.
- Numbers live in bluedots-schemas, not Signals.
- **`max_profiles_per_user` is removed in this ticket** (schema field, `resolveProfileLimit`, comments, tests, readme).
  - On bluedots-schemas `main` only `blue_dot/network.json` sets it, to 5 on both domains, which equals the env default. Removing it changes nothing in any deployment.
  - The domain schema uses `.strip()`, so a network.json that still has the key keeps loading; the key is ignored.
  - bluedots-schemas #58 (sets `max_profiles_per_user: 200`) is reworked to set `profile_limits` instead, and drops the old key.

## Behaviour

| Path | Live free, total free | Live full, total free | Total full |
|---|---|---|---|
| Create, complete (`/item/create`, `/admin/participant`) | live | **draft** + `message` | **409**, nothing saved |
| Create, incomplete | draft | draft | **409**, nothing saved |
| Edit that would go live (`PATCH /item/:id`, participant update) | live | stays **draft** + `message` | same as previous column |
| Consent that would go live (`/consent/profile-accept`, guardian OTP, participant `compliance`, age-triggered promotion) | live | stays **draft** + `message` | same as previous column |
| Unpause (`/item/lifecycle`) | live | **409**, stays **paused** | same as previous column |
| Pause / retire | allowed | allowed | allowed |

- Edit, consent and unpause act on an existing profile, so the total does not change; only the live limit matters.
- Unpause never turns a profile into a draft: only live profiles can be paused, and unpause only goes back to live.
- An edit to a profile that is already live is never blocked by the limit.
- Age-triggered promotion of several drafts: newest first until live is full.
- Accounts already over the limit on day one keep everything.
- A draft parked by the limit gets no "complete your profile" email/SMS. "Parked" is worked out from the gates, not stored.

## Responses

**Saved as draft (2xx)**: normal body, item shows `lifecycle_status: "draft"`, plus:

```json
"message": "Live profile limit reached. This profile has been saved as a draft. Pause or retire any live profile to publish it."
```

`message` is present only when the live limit kept the profile in draft; callers check for it.

**Unpause refused (409)**:

```json
{
  "error": "PROFILE_LIMIT_REACHED",
  "limit_type": "live",
  "message": "Live profile limit reached. Pause or retire any live profile to unpause this one."
}
```

**Create refused (409)**:

```json
{
  "error": "PROFILE_LIMIT_REACHED",
  "limit_type": "total",
  "message": "This account has reached its profile limit. Retire any profile to add another."
}
```

- Same `error` code as today, so aggregator-dpg bulk upload (`limit_reached`) and registration link (shows `message`) work unchanged.
- No numbers in any message.
- Both shapes follow the API contract standard (#839).

## Implementation

- **Live limit is a go-live gate.** Add `live_limit` to `GO_LIVE_GATE_CHECKS` (`services/items/go_live_gates.ts`), next to `owner_required`. Every go-live path already runs `classify_item`, so each one gets the check, and any new path does too.
  - Added automatically by `resolveGoLiveGates` when the domain has `profile_limits` (same as `consent_required` for guardian domains). Integrators don't list it.
  - Context (live count) is resolved like `owner_context`. Missing context fails closed: the profile stays draft.
  - Passes when the profile is already live, so edits never demote it.
  - Unpause passes no gates today; it opts into `live_limit` only, and a failure returns 409 instead of draft.
- **Locking.** Every path that resolves the `live_limit` context first takes the same advisory lock `assertProfileLimit` uses, so two writes can't both take the last live slot.
- **Total limit** stays a create-time check in `assertProfileLimit` (count `!= 'retired'` against `total`).
- `promoteEligibleDraftsForUser` gets `ORDER BY created_at DESC` (no order today).
- `skip_profile_limit` keeps working.

## Notifications

- A save that changes nothing (no field, location or status change) sends no "updated" email/SMS. Re-saving a parked draft while the live limit is full is therefore silent; if it goes live, the owner gets the usual "updated" message.

## Other teams

Signals sends `message`; callers choose to show it. Nothing breaks if they don't.

- aggregator-dpg: show `message` on bulk upload row and registration link success.
- voice-dpg: read `message` out.
- Signals UI (own PR, #928):
  - Show `message` as a "Saved as draft" warning on create, edit and the consent step; the limit 409s (create, unpause) as toasts.
  - Own-profile list pages through every profile (pages of 100) instead of the hardcoded `limit: 100`.
  - A draft can be saved with no changes, so a parked draft can be published.
  - Sidebar: Create Profile above the list; only the list scrolls, My Actions stays in place.
  - Map count leaves out the viewer's own profiles, which the map never draws.

## Out of scope

- `/admin/participant` item list size: separate ticket, tied to the endpoint review (#950). If changed, use `limit` / `lifecycle_status` query parameters, not a hardcoded count.

## Tests

- Every path in the Behaviour table, each column.
- Parked draft, slot freed, update with no changes: goes live.
- Edit of a live profile while live is full: stays live.
- Unpause while live is full: 409, stays paused.
- Two writes racing for the last live slot (create, consent, unpause): only one goes live.
- Age promotion with fewer free slots than drafts: newest go live.
- Domain without `profile_limits`: same as today.
- network.json that still has `max_profiles_per_user`: loads, key ignored.

## How a parked draft goes live

On the next update. Every save re-runs the go-live check, including a save with no changes, so clicking **Update** after a live slot frees up publishes the draft. No new API.

- Signals UI: `PATCH /item/:id`. aggregator-dpg / voice: `POST /admin/participant` with `item_id`.
- No auto-publish: retiring one profile must not silently publish a different one.
