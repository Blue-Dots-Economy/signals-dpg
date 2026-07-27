# Consent version upgrades & lifecycle — shippable without Keycloak

**Issue:** [#364](https://github.com/Blue-Dots-Economy/signals-dpg/issues/364) — Conditions when Terms & Conditions become void
**Epic:** [#99](https://github.com/Blue-Dots-Economy/signals-dpg/issues/99)
**Date:** 2026-07-27
**Status:** Design — pending review.

**Relationship to the cross-DPG design.** `2026-06-25-consent-management-design.md` proposed a standalone `consent-service` keyed on the Keycloak `sub`. Keycloak convergence is parked (see `project_keycloak_migration_design.md`), and #364 is urgent. This spec delivers #364 **inside the existing config-driven, in-Signals implementation**, with no Keycloak dependency. It is deliberately shaped so the mechanisms it adds map onto the eventual service (see the migration issue). Gaps left open by shipping without Keycloak are tracked in the no-Keycloak gap issue.

**Builds on:** `2026-07-22-participant-compliance-consent-design.md` and `2026-07-24-participant-consent-activation-readstatus-design.md` (the `compliance` array, validation rules, and go-live gate). This spec does not restate those rules.
**Related:** `2026-07-27-consent-point-registry-design.md` — #364's "new purpose" and "data transfer" scenarios (adult #4/#5, minor #5) need a new consent *category*, which is that spec's job. They are out of scope here.

---

## 1. Problem

A version bump does nothing today.

- `hasAcceptedTermsAndPrivacy` (`services/consent_acceptance.ts:16`) treats presence of **any** row at **any** version as accepted. The only version comparison in the system lives in the UI (`hooks/use-consent-gate.ts:54`), so the re-consent gate is client-side and every non-UI channel bypasses it.
- `profile_creation` re-consent is structurally impossible: the idempotency check (`accept_profile_consent.ts:112`) is version-agnostic, and the partial unique index on `(user_id, item_id, source)` would reject a second row anyway.
- Clients send a `version` in every accept body and the server ignores it — no stale-version guard.
- `effective_from` is validated as a non-empty string and **read nowhere**. There is no way to stage a version ahead of its legal effective date.
- `consent_record` has no `event` column, so every row is an implicit accept. "Latest event per subject by `seq`" — the semantics the table's own docstring claims — has never been expressible.
- No revoke, no expiry, no consent lapse on account deletion.
- Every document in every network is at `current_version: 1` with a single-element `versions` array. **The upgrade path has never been exercised.**

## 2. Key design decisions

### 2.1 Advance-notice acceptance, not a cliff

The severe question — "what happens to live profiles when terms v2 ships?" — is mostly avoidable. Announce the change, collect acceptance during a notice window, and the switchover is a no-op for everyone who already accepted.

Two distinct notions replace the single `current_version`:

| | resolves to | used for |
|---|---|---|
| **`versionInForce(now)`** | highest version with `effective_from <= now` | **gating** — what `needs_consent` compares against |
| **`versionOnOffer(now)`** | highest version with `notice_from <= now` | **presentation** — what the UI renders and what an accept records |

Between `notice_from` and `effective_from`, v2 is offered **non-blocking** ("Our terms change on 1 Sep — review and accept now") while v1 remains in force. An acceptance of v2 is recorded *before* it is in force.

**Satisfaction rule:** a point is satisfied when `latest accepted version >= versionInForce(now)`. So at `effective_from`, everyone who accepted during the notice window sees nothing — no gate, no demotion. This is the whole point.

`current_version` is retained as an **explicit pin**: when set, it overrides date resolution for both notions. That keeps today's configs working unchanged and gives an escape hatch.

An **emergency bump** sets `notice_from == effective_from == today`, which behaves exactly like today's hard gate.

### 2.2 The residual tail

Only users who never appeared during the notice window reach `effective_from` unaccepted. For them, in order:

1. **At `effective_from`** — blocking re-consent modal on next login. New PII-revealing actions and profile edits are gated immediately.
2. **Live profiles stay live** for `regate_grace_days` (network config, default `30`) past `effective_from`, with nudges sent (see the #367 spec).
3. **After the grace window** — demoted to `draft` by a sweep, generalising the existing one-off `backfill_demote_consentless.ts` into a scheduled job. Returns to `live` via the normal `promoteItemOnProfileConsent` path on re-accept.

Setting `regate_grace_days: 0` gives immediate demotion for a network that wants the strictest reading.

> **Open for review:** the grace window trades a short period of processing-under-stale-consent for avoiding a network-wide discoverability blackout. It is defensible because notice was given and nudges were sent. A reviewer who wants the strict DPDP reading should set the default to `0`.

### 2.3 `event` on the ledger is the keystone

Everything else in this spec — revoke, expiry, supersession, provenance — needs the ledger to record *what kind of* event a row is. This is the one schema change that unlocks the rest.

## 3. Data model

### 3.1 `consent_record` — new columns

| column | type | notes |
|---|---|---|
| `event` | `text NOT NULL DEFAULT 'accepted'` | `accepted` \| `revoked` \| `expired` \| `superseded` \| `provenance` |
| `expires_at` | `timestamptz NULL` | `accepted_at + consent_validity_duration`; NULL = no time expiry |

The default backfills every existing row to `accepted`, which is what they are. No data migration beyond the default.

**Index change.** Replace the partial unique index
`(user_id, item_id, source) WHERE level='item' AND consent_category='profile_creation'`
with
`(user_id, item_id, source, document_version) WHERE level='item' AND consent_category='profile_creation' AND event='accepted'`.

This is what unblocks `profile_creation` re-consent while still rejecting a double-submit of the same version from the same source. The `event='accepted'` predicate keeps a later `revoked` row from colliding.

**Latest-event lookup** uses the existing `consent_record_user_idx` ordering by `seq` — never timestamps.

### 3.2 `user` — one new column

| column | type | notes |
|---|---|---|
| `age_recorded_at` | `timestamptz NULL` | when the `age` snapshot was captured |

#331 / PR #359 deliberately store an **age snapshot, not a birthdate** (data minimisation). That decision stands. But a frozen snapshot means a ward never ages out, which is #364 minor #4.

`age_recorded_at` gives a privacy-preserving **lower bound** on current age with no new PII:

```
ageLowerBound = age + floor(yearsElapsed(age_recorded_at, now))
```

Because `isMinor` is `age <= 18` (fail-closed through the whole boundary year), a user recorded at 18 becomes an adult once the snapshot is a year old — `ageLowerBound = 19`. Exactly the transition we need, derived rather than stored. Backfill: `age_recorded_at = user.updated_at` for rows that already have an `age`, which is conservative (it can only *under*-estimate elapsed time, never over).

### 3.3 Consent config — new fields

Per document version, all optional and backward-compatible:

| field | type | notes |
|---|---|---|
| `notice_from` | ISO date | when this version starts being offered. Defaults to `effective_from`. |
| `change_summary` | Markdown string | author's "what's new"; rendered only in the re-consent / notice modal |
| `consent_validity_duration` | ISO 8601 duration (e.g. `P2Y`) | drives `expires_at`. Absent = no time expiry. |

`effective_from` becomes a **validated ISO date** (today: `z.string().min(1)`). Existing configs already carry real dates, so this is a tightening, not a break.

Per network (`network.json`, aggregator-visible section): `regate_grace_days` (int, default `30`).

**Validation invariants** (Zod `superRefine`, extending the existing checks):
- `notice_from <= effective_from` per version.
- `effective_from` values are strictly increasing with `version`.
- `current_version`, when set, exists in `versions` (already enforced).

## 4. Services

### 4.1 `resolveConsentVersion` — split into two resolvers

`services/consent_version.ts` gains:

```ts
resolveVersionInForce(input, now): Promise<number | null>
resolveVersionOnOffer(input, now): Promise<number | null>
```

Both keep today's brand-override-over-network-default merge and the `adult` / `u18` variant selection. The existing `resolveConsentVersion` becomes a thin alias for `resolveVersionOnOffer` — **writes record what was offered**, which is what the user actually read.

`now` is an injected parameter, never `Date.now()` inside the resolver, so the notice/effective boundaries are directly unit-testable.

### 4.2 `consentStatus` — the single source of truth

New `services/consent_status.ts`:

```ts
type PointStatus = {
  point: string;                 // 'user_terms' | 'user_privacy' | 'profile_creation' | ...
  accepted_version: number | null;
  version_in_force: number;
  version_on_offer: number;
  satisfied: boolean;
  needs_consent: boolean;
  reason: 'satisfied' | 'never' | 'version_bumped' | 'revoked' | 'expired' | 'superseded';
  offer_pending: boolean;        // on_offer > accepted, but in_force is still satisfied
  in_force_from: string | null;  // effective_from of the version on offer
  grace_expires_at: string | null;
};

consentStatus(userId, network, brand, opts?): Promise<Record<string, PointStatus>>
```

Resolution per point: latest event by `seq` → if `revoked`/`superseded` then `needs_consent`; else if `expires_at < now` then `expired`; else compare `accepted_version` against `versionInForce`.

`offer_pending` is what drives the **non-blocking** notice prompt. `needs_consent` is what drives the **blocking** gate. Keeping them separate fields is the whole advance-notice mechanism.

This service replaces the version-agnostic reads:
- `hasAcceptedTermsAndPrivacy` → `consentStatus` over the two user-level points.
- `hasAcceptedProfileConsent` → version-aware equivalent keyed on `item_id`.

**`guardianGateBlocksGoLive` stays the single source of truth for the age gate** (`.claude/rules/consent-v1.md`). This spec changes what "has consent" means; it does not add a second age check. The U18 promotion path continues to require a `source='guardian'` row.

### 4.3 Minor → adult supersession

Evaluated **lazily at status time** — no cron, consistent with expiry.

When `consentStatus` runs for a user on a guardian-gated domain and `ageLowerBound >= 19` while the latest `profile_creation` acceptance has `source='guardian'`, the service appends a `superseded` event against the guardian row and reports `reason: 'superseded'` → `needs_consent`. The now-adult user self-consents at the next present turn. Guardian rows remain in the ledger as history; nothing is deleted.

## 5. API

### 5.1 `GET /api/v1/consent/status` — additive

Adds a `points` object keyed by consent point, each a `PointStatus`. The existing `statuses: { terms: number[], privacy: number[] }` shape is **retained for one release** because `ConsentStatusResponseSchema` is shared with `/status-by-identifier`, and per `project_crossrepo_cutover_pattern.md` response-shape changes break consumers. Removal is a follow-up once the UI reads `points`.

### 5.2 `GET /api/v1/consent/active` — new, public

`?network=&audience=participant&variant=adult|u18`

Returns, per point: the version on offer, its title/content/`change_summary`, `effective_from`, and whether it is currently in force. Public and pre-login, per §10 of the cross-DPG design. Needed by the login gate before a session exists, and by the aggregator QR form (see the QR spec) so participant consent copy has **one** source of truth instead of being duplicated into the aggregator config.

### 5.3 Stale-version guard

`/consent/accept`, `/consent/profile-accept`, and the action `body.consent.version` all currently send a version that is ignored. Each now compares it against `versionOnOffer`:

```
409 STALE_CONSENT_VERSION
{ error, message, point, sent_version, version_on_offer, document: { title, content, change_summary } }
```

The body carries the current document so the client re-renders without a second round trip. Applies uniformly to UI, voice, and QR-link channels.

### 5.4 `POST /api/v1/consent/revoke` — new

Body `{ point, item_id? }`, authenticated, self-only.

- `user_terms` / `user_privacy` → `revoked` event; **stop-processing**: all the user's items in that network → `paused`.
- `profile_creation` → `revoked` for that `item_id`; that item → `paused`.
- Action consent is **not revocable** — it was consumed at the moment of disclosure. Returns `400 NOT_REVOCABLE`.

`paused` is chosen deliberately: it is already sticky (`promoteItemOnProfileConsent` never promotes out of `paused`), so a revoked user cannot be silently re-promoted by an unrelated write.

### 5.5 Expiry and account deletion

- **Expiry** is computed lazily in `consentStatus` (`expires_at < now`). No cron. Matches §9 of the cross-DPG design.
- **Account deletion** appends `erasure_requested` for every point and pauses all items. **Ledger rows are never deleted** — they are the legal proof. The cross-service erasure fan-out (aggregator rows, search index, offline copies at onboarding orgs) is explicitly **out of scope** and tracked in the migration issue.

## 6. UI

- `useConsentGate` consumes `points` and distinguishes two states: `needs_consent` → existing blocking modal; `offer_pending` → **new dismissible notice banner/modal** showing `change_summary` and the in-force date ("These terms take effect on 1 Sep. Review and accept now.").
- `ConsentModal` renders `change_summary` above the document body when present.
- **Fix `mergeConsentConfig`** (`hooks/use-consent-config.ts:12`): it rebuilds the config with only `documents` + `actions`, silently dropping `u18_documents` whenever a brand override exists. Both real brand configs (`blue_dot/upsdm`, `orange_dot/onetac`) hit this, so a U18 guardian on a branded deployment is shown **adult** copy while the server records the **u18** version. Today both sets are at v1 so the integer coincides; the moment either set is bumped independently the ledger asserts a version the guardian never saw. The merge must carry every top-level key, with a test asserting `u18_documents` survives.
- 409 handling: re-render from the returned document and ask again, rather than surfacing an error.

## 7. Testing

**Pure/unit** — `versionInForce` vs `versionOnOffer` across the notice boundary (before `notice_from`, during the window, at `effective_from`, after); `current_version` pin overriding date resolution; satisfaction rule `accepted >= in_force`; `needs_consent` for each `reason`; expiry arithmetic; `ageLowerBound` at the 18→19 boundary including a null `age_recorded_at`; validation invariants (`notice_from <= effective_from`, monotonic dates); `mergeConsentConfig` preserving `u18_documents`.

**API/integration** — accept during the notice window then cross `effective_from` with **no** gate raised (the headline behaviour); tail user gated at `effective_from`; grace expiry demoting to `draft` and re-accept re-promoting; `profile_creation` re-consent at v2 succeeding where it previously collided; 409 on every accept route; revoke pausing items and blocking silent re-promotion; expiry lapse; minor→adult supersession appending `superseded` and requiring self-consent; `/consent/active` unauthenticated.

**Explicitly covered because it is the historical bug class:** every go-live path routes through `guardianGateBlocksGoLive` (#311). A version-aware consent check must not introduce a second path that reads consent presence directly.

## 8. Out of scope

- New consent categories for "new purpose" / "data transfer" (#364 adult #4/#5, minor #5) → the consent-point registry spec.
- Nudge notifications → the #367 spec (this spec defines *when* a nudge is warranted; #367 delivers the sending).
- Cross-service erasure fan-out, consent receipts, DPV/DEPA projections, operator (org/coordinator) re-consent → no-Keycloak gap issue and migration issue.
- Removal of the deprecated `terms_accepted` / `privacy_accepted` columns (#270).
- Admin authoring UI — publishing remains a config edit plus ConfigMap render, and `network.json`/`consent.json` edits start in Signals `examples/schemas/` per `feedback_network_config_source_of_truth.md`.
