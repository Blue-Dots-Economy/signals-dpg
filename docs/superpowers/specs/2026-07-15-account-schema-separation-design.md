# Account schema separation — declarative, per-domain account contract — design

**Date:** 2026-07-15
**Issue:** [Blue-Dots-Economy/signals-dpg#308](https://github.com/Blue-Dots-Economy/signals-dpg/issues/308) — *Declarative, per-domain account schema — separate account ('Who I Am') from the profile item schema*
**Labels:** area:api, area:db, area:networks, type:feature, needs:decision
**Related:** #207 (draft profile creation / minimal required set), #143 (U18 OTP to guardian), #244 (network-schema U18 + login gating), #280 (seeker/provider schema verification), #180 (fresh-install DDL vs migrations; recompute on schema change), Blue-Dots-Economy/bluedots-allusecase-schemas#6 (network-schema `u18` + searchable/filterable flags)

## Summary

Signals separates account ("Who I Am") from profile ("What I Need" / "What I Have") **internally** — the account is a better-auth `user` row; the profile is a schema-typed item validated against `network.json`. But there is **no declarative, published account contract**. Consumers that build account-creation forms (Aggregator, Voice bots, Signals UI) therefore fall back to reading the **item/profile schema** (`profile_1.0.required = [name, location, age, phone]`) to infer what an account needs. That makes the profile-item schema do double duty as an implied account contract — the coupling this design removes.

We introduce a **first-class, declarative, per-domain account schema**:

1. **A central account catalog** — the network-agnostic set of identity attribute *definitions* ("Who I Am": name, identifier, date of birth, guardian, location, consent, attribution). It declares attributes and their types/privacy, **not** requiredness. Nothing is mandatory just by being in the catalog.
2. **A per-domain `account_schemas` block in `network.json`** — a sibling of that domain's `item_schemas`, versioned exactly like items (`account_1.0`). It **selects** which catalog fields are required for that domain and declares domain-specific gating (notification-channel identifier rule, U18 enablement, consent).
3. **A schema-read endpoint** consumers render the account form from — so nobody reads `item_schemas` for account fields again.

The account-creation **endpoints stay singular** (`POST /api/auth/unified-otp/verify` for self-signup, `POST /api/v1/admin/participant` for admin/bulk); their **payloads become account-schema-driven** rather than hard-coded Zod.

## Background — current behaviour

**Two account-creation surfaces exist today, both with hand-coded required sets:**

- **Self-signup (UI):** `POST /api/auth/unified-otp/verify` creates the `user` row (`adapter.create({ model: 'user', … })`). Required fields are inline in the `unified_otp` plugin (`name` optional, defaults to `'user'`; one of email/phone).
- **Admin/bulk:** `POST /api/v1/admin/participant` → `authInstance.api.signUpEmail(...)`, validated by `UpsertParticipantRequest` in `packages/schemas/src/admin/participant.ts` — which **hard-codes** `name` (`min(1)`), a one-of(email, phone) refine, and the `terms_accepted`/`privacy_accepted` booleans. `network`/`domain`/`item_type` are free strings that merely *default* to `blue_dot`/`seeker`/`profile_1.0`; they are not used to shape the account payload.

**Where item schema is (correctly) used — for the profile item only:** `network.json`'s `profile_1.0.required` is read by `item_service.ts` (`createItemInternal`) to validate the profile **`item_state`** and to gate draft/live lifecycle. It is never consumed to validate the `user` row.

**The `user` table today** (`apps/api/db/postgres/schema/auth.ts`) has: `id, name, email?, emailVerified, phoneNumber?, phoneNumberVerified, dateOfBirth, termsAccepted, privacyAccepted, role, banned…, onboardedByOrgId, onboardedVia, onboardedSourceId, onboardedAt, tags`. There is **no `location`, no guardian, no `network`/`domain`** column. Domain is purely an item property; the seeker/provider "single-domain-lock" is inferred **live** from the `items` table (`resolve_domain_lock.ts`), not stored on the account.

**Notification-channel config** (`SELF_SIGNUP_MODE`, `LOGIN_CHANNELS`) today gates *which identifier may authenticate/sign up*, enforced in the OTP plugin. It does **not** yet drive which account *fields are required*.

**Net problem:** with no published account contract, the profile-item schema is the only machine-readable thing a consumer can read to build an account form — so item schema leaks into the account layer.

## Problems this solves

- **No declarative account contract.** Consumers infer account fields from the item schema. We need a published, machine-readable account schema, per-domain (seeker ≠ provider), that they render from.
- **Requiredness is context-dependent.** The same account differs by domain, by instance notification channel (phone-only vs email-only), and by age (U18 → DOB → guardian). The contract must express *conditional* requiredness, not a flat list.
- **Schema evolution.** If the account carries `network`/`domain`, it must also record the account-schema **version** it conforms to, so accounts can be migrated when the contract changes (the #180 problem, mirrored from items' `item_type`).
- **Domain becomes an account fact.** Per-domain schema requires the domain to be known at account creation; the seeker/provider gate should be authoritative on the account rather than inferred from items.
- **Guardian is a third party.** U18 guardian details are a *different person's* PII with their own verification/consent/erasure lifecycle (#143) — they should not pollute the identity row.
- **Central vs per-instance identity.** "Who I Am" is intended to be maintained centrally, but each Signals instance has its own `user` table and there is no cross-instance identity store today.

## Design decisions (agreed)

| # | Decision | Choice |
|---|----------|--------|
| Layering | Account vs profile | **"Who I Am" (account) is central identity; "What I Need"/"What I Have" are per-domain profile items.** The item schema stops being an implied account contract |
| Schema shape | Where account requiredness lives | **Two layers**: a central attribute *catalog* (definitions only, all optional) + a per-domain `account_schemas` block in `network.json` that selects/gates |
| Granularity | Per-domain vs per-network | **Per-domain** — seeker and provider can require different account fields |
| Versioning | Schema evolution | **`account_schemas: { "account_1.0": {…} }`**, mirroring `item_schemas`; the account row records `account_schema_version` |
| Identifier | Which of phone/email is required | Declared as `one_of` in the schema, **resolved against the instance notification channel** (`LOGIN_CHANNELS`) at request time |
| U18 | Minor handling | If `u18.enabled`, `date_of_birth` required; if resolved age < 18, guardian name + one-of(guardian phone/email) required |
| Guardian storage | Same table vs separate | **Separate `account_guardian` table** — third-party PII, sparse for adults, own verification/erasure lifecycle (#143) |
| Domain binding | Stored or inferred | **Persisted on the account** (`user.domain`); re-backs single-domain-lock (was item-derived) |
| Endpoints | New vs existing | **Singular, unchanged paths**; payloads become account-schema-driven; add a read-only `GET /api/v1/account/schema` |
| Central identity | Cross-instance "Who I Am" | **Out of scope for v1** (depends on IAM convergence); v1 is per-instance but schema-uniform |

## Two-layer account schema

Mirrors the EkStep/JobStack decomposition:

| Layer | Concept | Storage | Scope |
|---|---|---|---|
| **Account** | "Who I Am" — identity | `user` row (+ satellite tables) | central identity, per-instance today |
| **Profile — seeker** | "What I Need" | `profile_1.0` item | per network/domain |
| **Profile — provider** | "What I Have" | `job_posting_1.0` item | per network/domain |

The account schema itself is two layers: a **core catalog** (central, network-agnostic, declares attributes only) and a **per-domain block** in `network.json` (selects + gates + may add domain-specific attributes).

### Core account catalog

```jsonc
// central account catalog (network-agnostic definitions)
{
  "name":           { "type": "string", "private": true },
  "phone":          { "type": "string", "format": "e164",  "private": true, "identifier": true },
  "email":          { "type": "string", "format": "email", "private": true, "identifier": true },
  "date_of_birth":  { "type": "string", "format": "date",  "private": true },
  "guardian_name":  { "type": "string", "private": true },
  "guardian_phone": { "type": "string", "format": "e164",  "private": true },
  "guardian_email": { "type": "string", "format": "email", "private": true },
  "location":       { "type": "object" }        // open — see Open questions
}
```

### Per-domain `account_schemas` in `network.json`

A sibling of `item_schemas`, versioned identically:

```jsonc
"seeker": {
  "item_schemas":    { "profile_1.0": { /* ... */ } },
  "account_schemas": {
    "account_1.0": {
      "required":  ["name"],                        // selected from catalog
      "identifier": { "one_of": ["phone", "email"],
                      "gated_by": "notification_channel" },
      "u18":      { "enabled": true, "consent_text": "…" },
      "consent":  { "terms": true, "privacy": true },
      "extends_core": true                          // may add domain-specific attrs
    }
  }
}
```

### Requiredness resolution order

Given an instance + network + domain, the effective required set is computed as:

1. Start from the core catalog — everything optional.
2. Apply `account_schema.required`.
3. Apply `identifier.gated_by: notification_channel`: on a phone-only instance (`LOGIN_CHANNELS`) `phone` becomes required; email-only → `email`; both → the one-of holds (≥1).
4. Apply `u18`: if enabled, `date_of_birth` required; if resolved age < 18, `guardian_name` + one-of(`guardian_phone`, `guardian_email`) required.
5. Result = the effective required set used for validation and form rendering.

## Data model

New identity attributes register as better-auth **`additionalFields`** (so the adapter provisions/returns them) and mirror into Drizzle + `auth.sql`.

```
user (better-auth + additionalFields) — added columns:
  network                text  not null           -- e.g. 'blue_dot'
  domain                 text  not null            -- 'seeker' | 'provider'  ← binding
  account_schema_version text  not null            -- e.g. 'account_1.0'     ← versioning
  location               jsonb null                -- only if location lands in core (open)

account_guardian (new custom table, NOT better-auth managed; 1:N on user_id):
  id            uuid pk
  user_id       text fk -> user.id
  guardian_name  text
  guardian_phone text null            -- e164
  guardian_email text null
  verified_at    timestamp null       -- supports #143 U18 OTP-to-guardian
  consent_state  text null
```

- Guardian fields are **not** columns on `user` — a distinct person's PII with their own verification/erasure lifecycle, sparse for the adult majority, extensible to 0..N guardians and OTP state (#143). The resolved account schema still *declares* them; the persistence layer routes them to `account_guardian`. The API payload stays singular.
- `location` is the holder's own 1:1 attribute; inline `jsonb` on `user` vs reusing the item-location pattern is left open.
- `guardian_*` / `location` are DB-nullable — requiredness is enforced by the resolved account schema, not DB NOT-NULL, so one table serves domains with different required sets.

**Domain binding & single-domain-lock.** `network` + `domain` are resolved at account creation (from the scoped front-door / request context, per the blue_dot 6-domain front-door design) and **persisted on the account**. The seeker/provider gate becomes a first-class account fact. The existing single-domain-lock (`resolve_domain_lock.ts`, today inferred from the `items` table) is re-backed by `user.domain`: item creation must match the account's domain. A live item-derived fallback is kept during transition.

## API

Endpoints stay singular; payloads become account-schema-driven.

- **`POST /api/auth/unified-otp/verify`** (self-signup) — inline name/identifier Zod replaced by validation against the resolved account schema for the request's `network`+`domain`.
- **`POST /api/v1/admin/participant`** (admin/bulk) — `UpsertParticipantRequest` stops hard-coding the required set; accepts a structured `account` payload validated against the resolved account schema. `network`/`domain` become required inputs; profile `item_state` continues to validate separately against `item_schemas`. Attribution (`onboardedByOrgId` from `x-acting-org-id`, `onboardedVia` from `channel`, `onboardedSourceId`, `tags`) is unchanged and treated as first-class account data.

**New — schema-read endpoint** (the contract consumers render from):

```
GET /api/v1/account/schema?network=blue_dot&domain=seeker
→ {
    account_schema_version: "account_1.0",
    fields:   [ { name, type, private, identifier? }, … ],   // resolved catalog subset
    required: ["name", "phone"],                              // AFTER channel resolution
    identifier: { one_of: ["phone","email"], required: "phone" },
    u18:      { enabled: true, guardian_required_when_minor: true },
    consent:  { terms: true, privacy: true }
  }
```

May extend the existing `GET /api/v1/auth/config` (which already returns `selfSignupAllowed`/`loginChannels`) or sit beside it.

**New — shared account validator** (analogous to `validateAgainstJsonSchema` for items): takes payload + resolved account schema, enforces the composed required set + U18 conditional logic. Used by **both** endpoints so self-signup and admin/bulk validate identically.

## Consumers & migration

- **Consumers**: Aggregator, Voice, Signals UI migrate to the schema-read endpoint for the account form — the actual removal of the item-schema-as-account-contract coupling.
- **Migration**: backfill `network`/`domain`/`account_schema_version` on existing `user` rows; create `account_guardian`; convert `resolve_domain_lock` to read `user.domain` (keep item-derived fallback during transition). Fresh-install DDL vs migration split follows #180.

## Testing

- Resolution unit tests: catalog → required set for each combination of `account_schema.required` × notification channel (phone-only / email-only / both) × U18 (disabled / adult / minor).
- Validator tests: payloads pass/fail against resolved schemas; guardian conditionally required when minor; identifier one-of enforced.
- Endpoint tests: self-signup and admin/bulk validate identically against the same resolved schema; `network`/`domain` persisted; guardian routed to `account_guardian`.
- Lock tests: item creation rejected when domain ≠ `user.domain`; item-derived fallback path during transition.
- Schema-read endpoint contract test: response matches the resolved required set for a given network/domain/instance channel config.

## Open questions (`needs:decision` — product / EkStep)

- **Location in core account?** Is `location` a core "Who I Am" attribute (and if so inline `jsonb` on `user` vs normalized), or does it remain profile-only? Ties to existing config-driven geotagging.
- **U18 age source & recomputation.** Age is derived from `date_of_birth` at creation; do we recompute the minor→adult transition (guardian requirement lapses at 18) on a schedule, or only on next write? (mirrors #180's recompute-on-change concern.)
- **Domain binding: strictly single, or multi-domain later?** This spec persists a single `domain`. Relaxing to a set (a user holding both seeker + provider) is deferred; confirm single is acceptable for v1.
- **Central identity store.** True cross-instance "Who I Am" (one identity across instances) depends on IAM convergence (Keycloak migration) and the consent-management work; out of scope here. v1 keeps identity per-instance but schema-uniform (same core catalog everywhere).

## Out of scope / dependencies

- Network-schema `u18` flag + searchable/filterable declarations — bluedots-allusecase-schemas#6.
- Consent ledger versioning — consent-management design.
- Cross-instance central identity + mutual auth — Keycloak-convergence work.
- U18 OTP-to-guardian delivery mechanics — #143 (this spec only provides the `account_guardian` home for it).
