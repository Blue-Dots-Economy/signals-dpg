# Participant API — accept consent from external channels (compliance) — design

**Issue:** [#309](https://github.com/Blue-Dots-Economy/signals-dpg/issues/309) — Flags/variables passed for terms & consent to Signals DPG
**Date:** 2026-07-22
**Status:** Design approved; implementation pending

## Problem

External channels (voice bot via voice-dpg, aggregator-dpg, bulk CSV) create users and
profiles through `POST /api/v1/admin/participant`. Today that endpoint takes two flat
booleans, `terms_accepted` and `privacy_accepted`, which must be literally `true`. It:

- writes only the **legacy user-table boolean columns** (`user.terms_accepted`,
  `user.privacy_accepted`) — which are **write-only / stale**: nothing reads them for any
  gate or decision (verified by grep; the real gate `hasAcceptedTermsAndPrivacy` reads the
  `consent_record` ledger, not these columns);
- **never records the `consent_record` ledger** and **never records `profile_creation`
  consent**, so every profile it creates is stuck in `draft` — invisible on the network and
  unusable for actions — until someone completes consent through the web UI later.

The consent ledger (`consent_record`) is the real source of truth. #309 makes the
participant endpoint record consent into that ledger from a new `compliance` array so that a
profile created via an external channel can be **promoted to `live`** on the same call
(subject to the existing completeness + guardian gates).

## Scope

**In scope** — recording, via the participant API:

- `terms` (user-level)
- `privacy` (user-level)
- `profile_creation` (item-level) → and promoting the item to `live`

**Out of scope (deferred):**

- **Action/connect consent** (issue item #4, "connect & share profile with PII") — belongs
  to the `action/perform` API, tracked separately.
- **Guardian / U18 consent** — structurally cannot be captured through a server-to-server
  onboarding call: guardian consent is an OTP verified against the *guardian's* own
  phone/email to prove the guardian (not the ward) agreed. The passive, fail-closed
  `guardianGateBlocksGoLive` keeps minors (and null-DOB users on gated domains) in `draft`
  automatically; no new code needed. Guardian consent is completed later via the web UI.
- **Read-consent-content API** (voice bot fetching consent copy to read to the user) — a
  separate follow-up.
- **Promoting `channel` to a first-class indexed column** — only needed if/when consent is
  reported by channel at scale; use `metadata.channel` for now.

## Background — the consent model (as-is)

- `consent_record` is an append-only ledger. Latest event per `(subject, category)` wins by
  `seq`. Content is never stored — only `(category, version)`; copy lives in `consent.json`.
- **Version is always derived server-side** by `resolveConsentVersion(network, brand,
  category)`. A client-supplied version is never trusted.
- Categories: user-level `terms` / `privacy`; item-level `profile_creation` (keyed on
  `item_id`); plus `action` (deferred here).
- `source` column records *which flow / who* produced the consent (`signup`, `login`,
  `profile`, `action`, `guardian`, `self`). The `profile_creation` guardian promotion path
  matches specifically on `source='guardian'`.
- Go-live: a profile becomes `live` only when required fields are complete **and**
  `profile_creation` consent is accepted, via `promoteItemOnProfileConsent`
  (`services/item_service.ts`), which runs `guardianGateBlocksGoLive` — the single,
  fail-closed age gate. Gated domains (`guardian_consent_required: true`, the `seeker`
  domains in pilot networks) hold minors and null-DOB users in `draft`; non-gated domains go
  live regardless of age.

## Locked design decisions

1. **Key shape — level-namespaced keys.** The `compliance` entry keys are `user_terms`,
   `user_privacy`, `profile_creation`. No version in the key (server derives it). `key` is a
   free string in the schema (not an enum) so an unrecognised key — e.g. a future
   action/connect key — is ignored rather than rejected.

2. **Accept-only ledger; all optional.** Record each entry whose `value === true` as one
   ledger row. `value:false` / absent → **skip** (no row). Rejections are not persisted. A
   user may be created with zero consent rows. A profile can never promote without `terms` +
   `privacy` in the ledger (prerequisite), so `profile_creation` alone does nothing.

3. **Rollout — additive, tolerate-and-ignore the old booleans.** Add optional `compliance`.
   Keep `terms_accepted` / `privacy_accepted` accepted in the payload as **optional and
   ignored** (drop the must-be-`true` refine); they map to nothing. Absent → no change.
   Existing callers keep validating and behave exactly as today (no ledger consent → profile
   stays `draft`). Stop hardcoding the stale `termsAccepted`/`privacyAccepted` columns in
   `buildOnboardingSet`. A later cleanup ticket removes the dead booleans/columns.

4. **Source & traceability — reuse existing sources + `metadata`.** No new column.
   - `terms` / `privacy` → `source='signup'`
   - `profile_creation` → `source='profile'` (non-guardian — so an adult promotes and a
     minor correctly stays `draft`; and it is not counted as guardian consent)
   - every row carries `metadata: { channel, via: 'admin_participant', key }`, where
     `channel` comes from the payload (`voice` | `bulk` | `link` | `self`). This
     distinguishes voice-vs-portal ("how") while `source` carries who/what-flow.

5. **DOB — full date, already handled.** The payload already accepts optional
   `date_of_birth` (date or ISO datetime) and stores it on `user.date_of_birth`; the gate
   reads exactly that. No new DOB plumbing.

## Architecture — Approach 2 (dedicated helper)

A single new service isolates all consent-recording logic; the (already large) participant
handler calls it once per branch. The two shared, tested pieces —
`resolveConsentVersion` and `promoteItemOnProfileConsent` — are reused; the existing consent
routes are **not** touched.

### A. Schema (`packages/schemas/src/admin/participant.ts`)

Request additions/changes:

```ts
compliance: z
  .array(z.object({ key: z.string().min(1), value: z.boolean() }))
  .optional(),

// deprecated: accepted so existing callers don't break, but ignored
terms_accepted: z.boolean().optional(),
privacy_accepted: z.boolean().optional(),
```

Response additions (`ParticipantItemSnapshot` / `UpsertParticipantResponse`):

- `lifecycle_status: string` on each returned item — so the voice bot can tell **live vs
  draft** (usable vs held). Added **only** to this endpoint's response.
- `consent_recorded: number` (top-level) — count of ledger rows written this call.

### B. Service (`apps/api/src/services/participant_consent.ts`)

```ts
export async function recordParticipantConsent(
  tx: DbOrTx,
  args: {
    compliance?: { key: string; value: boolean }[];
    userId: string;
    itemId?: string;      // present when a profile item was created/targeted
    network: string;
    brand?: string | null; // null today (payload carries no brand → network default)
    channel: 'voice' | 'bulk' | 'link' | 'self';
    acceptedAt: Date;
  },
): Promise<{ recorded: number; promoted: boolean }>;
```

Logic:

1. Empty/absent `compliance` → return `{ recorded: 0, promoted: false }`.
2. Map keys → `(level, category)`: `user_terms→(user,terms)`, `user_privacy→(user,privacy)`,
   `profile_creation→(item,profile_creation)`. Ignore unknown keys. Keep only `value===true`.
3. For each user-level entry: `resolveConsentVersion({ network, brand, category })`; if
   `null` (category not configured) skip with a warn log; else insert a `level:'user'` row
   with `source:'signup'`, `metadata:{ channel, via:'admin_participant', key }`, `acceptedAt`.
4. `profile_creation` only if **`itemId` present** and **`hasAcceptedTermsAndPrivacy(tx,
   userId, network)`** is true (the portal's prerequisite). Resolve version, insert a
   `level:'item'`, `category:'profile_creation'`, `source:'profile'` row (same metadata
   shape). On PG `23505` (partial unique index) treat as already-recorded (idempotent).
   Then call `promoteItemOnProfileConsent(tx, itemId)` to attempt go-live.
5. Return `{ recorded, promoted }`.

The guardian gate is inside `promoteItemOnProfileConsent`; minors / null-DOB on gated
domains no-op there and stay `draft`.

### C. Handler wiring (`apps/api/src/routes/v1/admin/participant.ts`)

Call `recordParticipantConsent` **once**, inside the transaction of each branch so consent
rows + promotion commit atomically with the user/item write:

- **create_new_user** — inside the existing `db.transaction`, after `create_profile_item`;
  pass the new `itemId`.
- **insert_item** — wrap the item insert + consent in a transaction; pass the new `itemId`.
- **update_item** — within a transaction; pass the existing `itemId` (records
  `profile_creation` for it if sent, then promotes).
- **account_only** — no item; user-level `terms`/`privacy` only (`itemId` undefined →
  `profile_creation` skipped). Records for **both new and existing** users when `compliance`
  is present: since the version is derived server-side at record time, a returning user
  re-accepting over voice after a Terms/Privacy version bump automatically records the
  *current* version (append-only, latest-wins by `seq`).

Also: remove `termsAccepted: true` / `privacyAccepted: true` from `buildOnboardingSet`.

### D. Edge cases & error handling

- `profile_creation:true` but no item → skipped (log).
- `profile_creation:true` but terms/privacy not satisfied → skipped (prerequisite), matching
  `accept_profile_consent`'s `CONSENT_PREREQUISITE_MISSING` behavior (here we skip silently
  rather than 409, since everything is optional).
- Minor / null-DOB on a gated domain → `promoteItemOnProfileConsent` no-ops; profile stays
  `draft`. No special handling.
- Idempotent re-send → `23505` on the `profile_creation` unique index is swallowed.
  User-level rows are append-only (duplicates benign; latest-wins by `seq`).
- Category not in `consent.json` (`resolveConsentVersion` → `null`) → skip that entry with a
  warn log; do **not** fail onboarding.
- Consent recording is **atomic** with user/item creation (same transaction). An unexpected
  failure rolls back the whole write, and the handler returns an error per the repo's
  route-never-throws convention. No half-recorded consent.

### E. Testing

- **Unit** (`participant_consent.test.ts`): key mapping; `false`/unknown keys skipped;
  prerequisite gate (no terms/privacy → no profile row); adult → `promoteItemOnProfileConsent`
  called; minor → not promoted; version-null → entry skipped.
- **Integration** (`participant.integration.test.ts`): adult + all three keys on a gated
  seeker domain **with DOB** → item returns `lifecycle_status: 'live'`; minor / null-DOB →
  `draft`; non-gated domain + `profile_creation` → `live`; account-only → user rows only, no
  item; legacy `terms_accepted`/`privacy_accepted` present → ignored, request still succeeds;
  `profile_creation` without terms/privacy → not recorded.
- Existing participant tests that send `terms_accepted`/`privacy_accepted` continue to pass
  (fields now optional-and-ignored).

### F. Docs

- `docs/operations/integrating-dpgs.md` — update the participant section: new `compliance`
  payload, the deprecated-and-ignored booleans, the `lifecycle_status` / `consent_recorded`
  response fields.
- `.claude/rules/consent-v1.md` — note that the participant endpoint now records the ledger
  (user `terms`/`privacy` + item `profile_creation`) and promotes via the shared path.

## Open items (external, not blocking implementation)

- **Final key strings** — confirm `user_terms` / `user_privacy` / `profile_creation` (and
  the deferred action key name) with the voice-dpg team; the schema tolerates any string, so
  build can proceed and strings adjusted if corrected.
- **Voice U18 handling** — product decision (whether the voice call proceeds for minors);
  does not change Signals-side code (minors stay `draft` regardless).
- **Legal deliberation** (Aniket) — validity/scope of an external-service agreement; affects
  consent.json copy/versioning, not this endpoint's shape.
