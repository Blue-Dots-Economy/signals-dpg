# Participant consent — activation, multi-profile & read-status (extends #309)

**Issue:** [#309](https://github.com/Blue-Dots-Economy/signals-dpg/issues/309)
**Extends:** `docs/superpowers/specs/2026-07-22-participant-compliance-consent-design.md` (the base compliance-recording design, already implemented on branch `feat/participant-compliance-consent` / draft PR #354).
**Depends on:** PR #353 ("always-create profiles + per-user cap", #349) — see §Dependency.
**Date:** 2026-07-24
**Status:** Design — pending review.

## Why this extension

The base design (2026-07-22) added the `compliance` array, recorded consent into the ledger on the `/admin/participant` write path, and promoted profiles to `live`. Real usage surfaced more flows that must be handled:

- Aggregator **bulk / registration-link** creates a user + profile with *minimal* data and **no consent, no DOB** → `draft`. A later channel (voice) call must be able to **collect consent + fields + DOB and activate that profile**.
- A user can hold **multiple profiles** (post-#353); the bot must know **which profile has consent** and which is usable for apply/connect.
- The bot must be able to **read consent status** before driving the collection flow.

## Confirmed principles

- **`compliance` and `date_of_birth` are both optional.** Record only entries with `value === true`; absent / `false` / unknown keys → skip. No rejection is stored.
- **Fail-closed, no bypass:** missing DOB on a guardian-gated (seeker) domain → `draft`; a minor DOB → `draft`. Never assume adult.
- **Creating a profile requires no consent.** `item_state` (no `item_id`) always creates the profile; with no `profile_creation` it simply stays `draft`. Consent and DOB only gate **go-live**, never creation — they can be supplied on the create call, or later via the profile's `item_id`.
- **Consent scope differs by level:**
  - `terms`, `privacy` — **user-level**; accepted once, inherited by all the user's profiles.
  - `profile_creation` — **item-level**; each profile needs its own row (keyed to `item_id`) — but only to go live, not to be created.
  - `date_of_birth` — **user-level**.
- **Multi-profile routing (post-#353, refined here):** `item_state` *without* `item_id` → creates a **new** profile (bounded by `MAX_PROFILES_PER_USER`). **`item_id` targets that existing profile**, and `item_state` on that call is *optional*: if given it updates the fields, if omitted the fields are left unchanged. Either way the call records any `compliance` (incl. item-level `profile_creation` for that `item_id`), persists `date_of_birth` if provided, and re-promotes. *(This refines #353's resolver — which today routes an `item_id` with no `item_state` to the account-only path — so a consent-only or DOB-only activation can target a specific draft without re-sending its fields.)*
- **`date_of_birth` alone (no `item_id`, no `item_state`) → account-only**: persists the user's DOB, records any user-level consent, then promotes **all** the user's eligible consented drafts (DOB is user-level).

## Go-live gate checklist (unchanged, for reference)

A profile becomes `live` only when all hold: (1) required fields complete; (2) `terms`+`privacy` recorded (user-level); (3) `profile_creation` recorded (this item); (4) DOB present + adult on a gated domain; (5) currently `draft`. Promotion always runs through `promoteItemOnProfileConsent` → `guardianGateBlocksGoLive` (the single age-gate source of truth; never re-derived).

## Write side — `POST /admin/participant`

Already implemented on PR #354 (base design): optional `compliance`; deprecated-and-ignored `terms_accepted`/`privacy_accepted`; consent recording per verdict branch inside a transaction; `lifecycle_status` + `consent_recorded` on the response; promotion via the shared gate.

**New deltas in this extension:**

1. **Persist `date_of_birth` on the update path.** Today DOB is written only when a user is *created* (`buildOnboardingSet` in the create branches). The update/enrichment path never writes it. Change: when `date_of_birth` is provided for an existing user, update `user.date_of_birth` — **only when provided** (never overwrite with `null`) — and do it **before** promotion so the guardian gate sees the new value.

2. **Promote all eligible drafts on a DOB-bearing call.** Because DOB is user-level, setting it can unblock *several* of the user's profiles. When a call provides `date_of_birth`, after persisting it, re-run promotion for **all** the user's `draft` items that already have `profile_creation` consent (a helper, e.g. `promoteEligibleDraftsForUser(tx, userId)` — query the user's draft items in served networks, keep those with a `profile_creation` row, promote each via `promoteItemOnProfileConsent`). Bounded by the profile cap. Calls that don't carry DOB keep the existing per-item promotion only.

3. **Dedupe user-level consent.** When recording `terms`/`privacy`, skip the insert if a row already exists for `(userId, network, category)` at the **current** resolved version; write a new row only when it's genuinely new or the version changed. Prevents multi-profile users accumulating duplicate user-level rows. `profile_creation` stays per-item (its own `onConflictDoNothing` idempotency, unchanged).

4. **2nd (and Nth) profile:** a call with `item_state` and no `item_id` → `insert_item` creates a new profile (bounded by the cap). Consent is optional here too — with no `profile_creation` the new profile is created `draft`; include `profile_creation` (on this call, or later via the profile's `item_id`) to promote it. `terms`/`privacy` and DOB are inherited from the user, so a new profile needs only its own `profile_creation` + a complete `item_state` to go `live` (re-sending user-level keys is harmless — deduped per §3).

**Activation / enrichment call** (bulk-created draft → live):
```jsonc
POST /admin/participant
{
  "email": "asha@example.com",           // (or phone) existing user
  "name": "Asha P",
  "item_id": "‹draft profile id from the create response / GET›",   // REQUIRED to target it
  "item_state": { /* full enriched profile fields */ },             // completes the profile
  "date_of_birth": "1990-01-01",          // persisted now → age gate
  "compliance": [
    { "key": "profile_creation", "value": true }   // + user_terms/user_privacy if not already on file
  ],
  "network": "blue_dot", "domain": "seeker", "item_type": "profile_1.0"
}
```
→ updates fields, persists DOB (before promote), records consent, promotes → `live`.

**Full create example — new user + profile with all consent + DOB (single-call go-live):**
```jsonc
POST /api/v1/admin/participant
x-api-key: <apikey>
x-acting-org-id: <org id>
content-type: application/json

{
  "email": "asha@example.com",
  "phone_number": "+919876543210",
  "name": "Asha P",
  "date_of_birth": "1990-01-01",           // adult → passes the age gate
  "compliance": [
    { "key": "user_terms",       "value": true },   // user-level
    { "key": "user_privacy",     "value": true },   // user-level
    { "key": "profile_creation", "value": true }    // item-level (this profile)
  ],
  "channel": "voice",
  "item_state": { /* all required profile fields → complete */ },
  "network": "blue_dot",
  "domain": "seeker",
  "item_type": "profile_1.0"
  // no item_id → creates a new profile
}
```
→ creates the user (DOB stored) + a new profile; records `terms` + `privacy` (user-level) and `profile_creation` (item-level); adult + complete → promoted. Response:
```jsonc
{
  "user_id": "usr_…",
  "user_existed": false,
  "owned_elsewhere": false,
  "onboarded_at": "2026-07-24T…",
  "items": [
    {
      "item_id": "itm_…",
      "item_network": "blue_dot",
      "item_domain": "seeker",
      "item_type": "profile_1.0",
      "lifecycle_status": "live",
      "item_state": { … },
      "item_locations": [ … ],
      "created_at": "…",
      "updated_at": "…"
    }
  ],
  "consent_recorded": 3
}
```

### Activation payload variants

All of these target an existing user (identify by `email` or `phone_number`; `name` is required by the schema, so pass the existing name). Each promotes only if the profile ends up complete + the go-live gate passes.

**(a) Activate a draft by sending only its `profile_creation` consent — no field re-send** (user already has terms/privacy + adult DOB on file):
```jsonc
{
  "email": "asha@example.com",
  "name": "Asha P",
  "item_id": "‹draft profile id›",        // targets that profile; no item_state → fields unchanged
  "compliance": [ { "key": "profile_creation", "value": true } ]
}
// → records profile_creation for that item, re-promotes → live
```

**(b) Activate by sending DOB + user-level consent — no item targeting** (account-only; promotes ALL the user's consented drafts):
```jsonc
{
  "email": "asha@example.com",
  "name": "Asha P",
  "date_of_birth": "1990-01-01",          // persisted on the user (user-level)
  "compliance": [
    { "key": "user_terms",   "value": true },
    { "key": "user_privacy", "value": true }
  ]
  // no item_id, no item_state
}
// → records terms+privacy, persists DOB, promotes every draft profile that already has profile_creation
```

**(c) Activate a specific draft that only lacked DOB — send DOB with its `item_id`** (its `profile_creation` + user terms/privacy already recorded):
```jsonc
{
  "email": "asha@example.com",
  "name": "Asha P",
  "item_id": "‹draft profile id›",
  "date_of_birth": "1990-01-01"
  // no item_state, no compliance
}
// → persists DOB, re-promotes (this draft — and any other eligible drafts, since DOB is user-level)
```

**(d) Everything-at-once on one draft — consent + DOB together via `item_id`** (nothing was recorded at create time):
```jsonc
{
  "email": "asha@example.com",
  "name": "Asha P",
  "item_id": "‹draft profile id›",
  "date_of_birth": "1990-01-01",
  "compliance": [
    { "key": "user_terms",       "value": true },
    { "key": "user_privacy",     "value": true },
    { "key": "profile_creation", "value": true }
  ]
  // item_state optional — include it to also fill/complete the profile fields
}
// → records terms+privacy+profile_creation, persists DOB, re-promotes → live (if complete)
```

Note the prerequisite: `profile_creation` is only recorded once `terms` + `privacy` exist (on file or in the same call). Variant (a) assumes they're already on file; if not, include `user_terms`/`user_privacy` in that call too (as in (d)).

## Read side — `GET /admin/participant` (new)

Extend the read endpoint (`participant_read.ts` / `GetParticipantResponse`) to return consent status so the bot can drive the flow and pick a usable profile.

```jsonc
{
  "user_id": "usr_…",
  "user_consent": {
    "terms_accepted": true,        // plain boolean (any accepted row present)
    "privacy_accepted": true,      // plain boolean
    "has_date_of_birth": true      // presence only — NOT the DOB value (PII)
  },
  "items": [
    {
      "item_id": "itm_A",
      "item_type": "profile_1.0",
      "lifecycle_status": "live",
      "profile_consent_accepted": true,    // profile_creation recorded for THIS item
      "item_state": { … }
      /* … existing snapshot fields … */
    },
    {
      "item_id": "itm_B",
      "lifecycle_status": "draft",
      "profile_consent_accepted": false,
      "item_state": { … }
    }
  ]
}
```

- `user_consent.terms_accepted` / `privacy_accepted`: **plain booleans** (presence of any accepted row; version numbers are intentionally not surfaced).
- `user_consent.has_date_of_birth`: **presence boolean**, not the value.
- Per item: `profile_consent_accepted` (does this item have a `profile_creation` row) + `lifecycle_status` (already added by the base design).
- Computed via batched `consent_record` reads (user-level categories for the user; item-level `profile_creation` for the returned item ids) + the `user.date_of_birth` presence.
- **Auth/scoping unchanged:** same admin apikey + acting-org; aggregators still see only their own users; consent status follows the same scoping.

## Bot flow (case 4)

1. **GET** `/admin/participant` (email/phone) → read `user_consent` + per-profile `profile_consent_accepted` / `lifecycle_status`.
2. Determine what's outstanding for the target profile (consent? DOB? fields?). The bot computes completeness itself from `item_state` + the item schema — **no completeness hint is returned** by the API.
3. Collect the missing pieces from the user on the call.
4. **POST** the activation call above (`item_id` + `item_state` + `compliance` + `date_of_birth`) → `live`.

## Scenarios (consolidated)

| # | Scenario | Result |
|---|---|---|
| 1 | Bulk / reg-link create, no consent/DOB | `draft` |
| 2 | Voice create: consent + DOB(adult) + complete | `live` |
| 3 | Voice create: consent, no DOB | `draft` → activate later |
| 4 | Enrichment/activation (GET → POST `item_id`+state+compliance+DOB) | `live` |
| 5 | 2nd profile (`insert_item` + `profile_creation` + state) | `live` if complete + adult (inherits user-level) |
| 6 | Minor / unknown DOB on gated domain | `draft` (fail-closed) |
| 7 | Multi-profile | each profile `live` iff its own `profile_creation` + user-level (terms/privacy + adult DOB) satisfied |
| 8 | DOB supplied while user has several consented drafts | all eligible drafts promoted (§Write.2) |

## Future note — DOB → year-of-birth

Age capture is expected to move from full date of birth to **year of birth only**. Once that change is in place, the participant API accepts **year of birth** instead of a full `date_of_birth`, and the minor/adult computation uses the year. Until then we keep `date_of_birth` (full date) exactly as today — no change here.

## Out of scope

- **Action/connect consent** (issue item #4, share-PII on apply/connect) — belongs to the `action/perform` API. The GET status here is *profile/user* consent; choosing a profile for apply uses `profile_consent_accepted` + `live`, but the apply itself gates on action-consent separately.
- **Re-consent on version bump** — GET returns plain booleans, so a stale (older-version) acceptance is not surfaced; not handled now.
- **Guardian/U18 capture** — server-to-server can't do the OTP proof; minors go through the portal. Unchanged.
- **Read-consent-content API** (fetching consent copy text) — separate follow-up.

## Dependency & sequencing

PR #353 (always-create + per-user cap) is open on the same `feature` base and restructures the same handler/verdict surface (collides in `participant.ts` + the participant test files; no logical conflict in `item_service.ts`). **Land #353 first, then rebase `feat/participant-compliance-consent` onto it**, then implement these deltas. Post-#353 semantics are already assumed throughout this design (item_id required to target an existing profile).

## Already-done vs new work

- **Done on PR #354 (base design):** `compliance` schema + optional booleans; consent recording per branch (incl. update path); `lifecycle_status` + `consent_recorded`; promotion via the shared gate; conflict-safe `profile_creation` insert; minor-stays-draft e2e test.
- **New in this extension:** (1) persist DOB on the update path (before promote); (2) promote-all-eligible-drafts on a DOB-bearing call; (3) dedupe user-level consent; (4) GET consent-status fields (`user_consent` + per-item `profile_consent_accepted`); (5) tests for the activation, multi-profile, and read-status flows; (6) doc updates. Plus the #353 rebase.
