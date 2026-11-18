# Participant Verification — Design

**Issue:** [signals-dpg#883](https://github.com/Blue-Dots-Economy/signals-dpg/issues/883) · **Repos:** signals-dpg, aggregator-dpg · **Status:** Draft

## Summary

A coordinator from the **aggregator that onboarded the participant** verifies the participant's profile attribute by attribute. Once all required attributes are verified, Signals issues a **signed verification token**, stores it against the profile, and shows a **verified icon** in the aggregator portal and to the participant.

Verification is a **new go-live check**: on domains that enable it, a profile goes live only once it is `verified`, in addition to today's checks (required fields, consent). Verification has its own status alongside `lifecycle_status`; it is not a new lifecycle stage. Profiles that are already live or paused when verification is switched on keep their status.

**v1 scope:**
- the core framework end to end: config, verification states, signing, revocation and reads;
- the **individual** verification flow;
- onboarding APIs (CSV upload, self-register, registration link / QR) reporting verification state and failures;
- an optional **verification checkbox on CSV upload**, which marks the uploaded rows verified or partially verified;
- Signals-to-aggregator APIs returning **all** users.

**Not in v1:**
- multi-select verification in the portal (see Further enhancements);
- UI screens, which are designed after this design is shared;
- map and search/discover results.

## Key details

| Topic | Decision |
|---|---|
| **Signing method** | Plain signed JWT (JWS), **Ed25519 (`EdDSA`)**, using `jose` (already a dependency of `apps/api`) |
| **Private key storage** | New env var **`VERIFICATION_SIGNING_KEY`** (PKCS8 PEM) plus `VERIFICATION_SIGNING_KID`. Declared in `packages/config/src/secrets.ts` and `turbo.json`. Sourced like other secrets: root `.env` locally, the API Kubernetes secret when deployed. One key per instance; used only by `apps/api` |
| **Public key** | Derived from the private key and published at **`GET /.well-known/jwks.json`** |
| **Expiry** | **None.** A verification stays valid until it is revoked |
| **What is verified** | A **configurable subset** of attributes per domain in `network.json`: `verification.required_attributes` and `verification.optional_attributes` |
| **Go-live** | New gate `verification_required` in a domain's `go_live_required` (`network.json`). With it, a profile goes live only when it is `verified` **and** the existing gates pass. Domains without it go live as today |
| **Verification status** | `unverified`, `partially_verified` or `verified`, plus `not_applicable` (see Status model) |
| **Existing profiles** | Keep their current lifecycle status. Profiles already `live` or `paused` when the gate is switched on are marked **exempt** and stay live (and can be unpaused) while `unverified`. Existing drafts need verification to go live |
| **Who can verify** | Only the aggregator that onboarded the participant (`user.onboarded_by_org_id` = acting org). The profile must be `draft`, `live` or `paused` (not `retired`) |
| **Private attributes** | Verifying a private attribute (e.g. phone) needs `profiles.view_pii`. All coordinators get it by default; a coordinator without it can verify only the non-private attributes |
| **Token contents** | Issuer (the instance), the profile, the verifying **org (org level only, no coordinator id)**, each attribute as a **salted hash (not the raw value)**, issue time. The header carries the signing key's `kid` |
| **Where state lives** | signals-dpg only. aggregator-dpg provides the screen and calls Signals |
| **Who sees the status** | The aggregator portal and the **participant**, on their own profile in the Signals UI |

## Core framework (signals-dpg)

| Component | Responsibility |
|---|---|
| **Config loader** | Reads `verification` from `network.json`. Rejects at load time any attribute that isn't in the item schema. A domain with no block is `not_applicable` |
| **Verification service** | Records attribute checks, computes the status, and issues the token once all required attributes are verified |
| **Signer** | Loads the key at boot, signs with `jose`, serves the JWKS. If the key is missing, issuing fails and nothing else does |
| **Change hook** | Runs inside `updateItemInternal`, the single path every `item_state` write goes through. It compares the new value hashes with the verified ones and invalidates the checks that changed |
| **Go-live gate** | `verification_required` in `PROFILE_GO_LIVE_GATES` (`packages/schemas/src/network_workflow.ts`) and one entry in `GO_LIVE_GATE_CHECKS` (`apps/api/src/services/items/go_live_gates.ts`). Passes when the status is `verified` or the profile is exempt. Like `owner_required`, it reads state the caller loads into the gate context |
| **Lifecycle hook** | On retire, revokes the token and clears the hashes and token |
| **Read projection** | Adds the `verification` summary to profile, participant and dashboard reads |

## Status model

| Status | When |
|---|---|
| `unverified` | No attribute currently verified. **Every existing and every newly onboarded profile starts here** |
| `partially_verified` | At least one attribute verified, but not every required one. This also covers a profile whose token was revoked because a verified attribute changed |
| `verified` | Every required attribute verified, and an active token exists |
| `not_applicable` | The domain has no verification config, or the user has no profile (account-only) |

- **Lifecycle has no effect on the status.** Pausing changes nothing; retiring revokes.
- **Effect on lifecycle (gated domains):**

  | Situation | Lifecycle |
  |---|---|
  | New or draft profile, not yet `verified` | Stays `draft`, shown as **Pending verification** when every other gate passes |
  | Becomes `verified` and every other gate passes | `draft → live` in the same transaction. Item event published after commit and item-fetch cache cleared, as every lifecycle change must |
  | Becomes `verified` but another gate fails (e.g. consent not accepted) | Stays `draft` until that gate passes |
  | Live profile whose verified attribute changes | Status drops to `partially_verified`, so the profile goes back to `draft` until re-verified (item event published) |
  | Exempt (pre-existing live / paused) profile | Stays live; unpause works as today |

## Individual verification flow

1. **Open:** `GET …/verification?item_id=` returns the configured attributes, their current values (private ones only with `view_pii`), each attribute's check, and the status.
2. **Check:** `POST …/verification/checks` with `{ item_id, attribute, seen_updated_at }` (marks the attribute verified). Signals then:
   - checks ownership and that the profile is not retired;
   - locks the item row (`SELECT … FOR UPDATE`);
   - refuses with `409 VALUE_CHANGED` if the profile changed after the coordinator viewed it;
   - stores the check with a hash of the value.
3. **Issue:** when the last required attribute is verified, the token is signed and stored in the same transaction, the status becomes `verified`, and the go-live classifier re-runs, so the profile goes live if every other gate passes.
4. **Re-check:** after a verified attribute changes, the coordinator checks only that attribute again. Once all required attributes are verified, a new token is issued.

A coordinator without `profiles.view_pii` sees private attributes masked. The aggregator-dpg API rejects a check on them with `PII_PERMISSION_REQUIRED`, checked in the handler whatever the `RBAC_MODE`.

## Onboarding flows: states and failures

Verification **never blocks onboarding**. Every onboarding response carries the resulting `verification` summary.

| Channel | New profile | Existing profile updated |
|---|---|---|
| **CSV bulk upload** (`/admin/participant`, `channel=bulk`) | **Checkbox ticked:** the verification attributes filled in the row are marked verified, so the status is `verified` (all required present, token issued, can go live) or `partially_verified` (stays `draft` in gated domains). **Not ticked:** `unverified`; stays `draft` in gated domains | **Ticked:** the row's filled verification attributes are re-verified at their new values. **Not ticked:** unchanged values keep their status; a changed verified attribute invalidates that check and revokes the token, so the status becomes `partially_verified` (or `unverified` if no verified attribute remains) |
| **Self-register** (Signals UI, voice) | `unverified`; stays `draft` in gated domains | Same rule when the participant edits their profile |
| **Registration link / QR** | `unverified`; stays `draft` in gated domains | Same rule |
| **Account-only** (no profile) | `not_applicable` | — |

**CSV verification checkbox:**

- **aggregator-dpg:**
  - Upload-start gets a second, **optional** box: "I have verified the verification attributes for these users". The existing mandatory upload-permission box is unchanged.
  - The box has its own versioned document in `consent.json` and is recorded in aggregator-dpg's consent ledger next to the existing attestation.
  - If that ledger write fails, the upload is rejected, as it is today for the existing box.
- **Worker to Signals:** for each row, the worker adds an optional `verification` block to `POST /api/v1/admin/participant`: `{ attested: true, upload_id, attestation_version }`.
- **Signals:**
  - Marks attributes verified **only from this block**, never from `channel`. It accepts the block only from an aggregator acting org that owns the participant.
  - Each attribute filled in the row and on the domain's list is recorded as verified, with the uploading org and the upload as the source, at upload time.
  - When every required attribute is present, the token is issued (org level; it also names the upload).

**Failure scenarios:**

| Scenario | Result |
|---|---|
| Domain has no verification config | Onboarding succeeds; status `not_applicable` |
| Re-upload or edit with values that only differ in format | Values are normalised before hashing, so the status is kept |
| Re-upload changes a verified attribute | Onboarding succeeds. In gated domains the profile returns to `draft`. The row result reports `verification_revoked`, names the attributes, and returns the new lifecycle status. aggregator-dpg shows this in the upload's row results and `errors.csv` as a warning, not an error |
| Checkbox ticked but a row leaves some verification attributes empty | Row onboarded as `partially_verified` (`unverified` if none are filled). The row result lists the missing attributes as a warning |
| Checkbox ticked, but a value fails schema validation | The row fails as today; nothing is verified |
| Signing key missing when the last attribute is checked | The check is saved, the status stays `partially_verified`, and the response is `VERIFICATION_SIGNING_UNAVAILABLE`. Checking again after the key is set issues the token |
| The verification write fails (DB error) | It runs in the same transaction as the profile write, so the whole write fails and is reported as today's onboarding error. Profile data and verification never disagree |
| Profile retired by a later upload | Token revoked; hashes and token cleared |

## Signals-to-aggregator APIs: all users

Today the dashboard and export return only `draft` and `live` profiles. aggregator-dpg allows only `draft` or `live`.

- **signals-dpg `/aggregator/dashboard` and `/aggregator/export`:**
  - Accept every lifecycle (`draft`, `live`, `paused`, `retired`) plus `account_only`.
  - Account-only users (onboarded, no profile) don't appear in `item_metrics`. They are added from `user` where `onboarded_by_org_id` is the acting org and the user has no item. They come back as rows with `lifecycle_status: "account_only"` and verification `not_applicable`.
  - Each row carries the `verification` summary, joined from `profile_verifications`.
  - A new `verification_status` filter is added.
  - **The default stays `draft` and `live`,** so existing callers are unaffected. aggregator-dpg asks for all lifecycles explicitly.
- **aggregator-dpg:**
  - The `lifecycle` filter is widened to all values plus `account_only`, defaulting to all.
  - The verification status and filter are passed through.
  - Retired rows show no PII, because retire has already scrubbed it.

## DB changes (signals-dpg)

**One new table. No changes to existing tables.**

`profile_verifications`, with one row per profile:

| Column | Holds |
|---|---|
| `item_network`, `item_domain`, `item_type`, `item_id` | The profile (primary key). FK to `items` with `ON DELETE CASCADE` |
| `attribute_checks` (jsonb) | Per attribute: decision, value hash, verifying org, time |
| `status` | `unverified`, `partially_verified` or `verified` |
| `token`, `kid`, `issued_at`, `issued_by_org_id` | The signed token and its details, filled once verified |

- **New column for exemption:** `go_live_exempt` (boolean, default false) on this table.
- **Backfill only when a domain switches the gate on:** a one-off script inserts an `unverified`, `go_live_exempt = true` row for each profile that is `live` or `paused` at that time. Run it **before** adding `verification_required` to the domain's config, so no profile is demoted. Every other profile with no row reads as `unverified` and not exempt.
- **Dashboard:** joins this table to show the status, so no change to `item_metrics` is needed.
- **History:** only the latest decision per attribute is kept. A full history is a later item.

## Key rotation

Tokens have no expiry, so rotation **re-signs** them rather than keeping old keys published:

1. Generate a new key pair and update the secret with the new `kid`.
2. A one-off job re-signs every `verified` row with the new key. The attribute hashes are already stored, so no coordinator action is needed.
3. Once the job finishes, the old key is dropped and `/.well-known/jwks.json` publishes only the new key.

**If a key is compromised,** do the same immediately. Any profile whose data no longer matches its stored hashes is revoked instead of re-signed.

## API changes

| Repo | Change |
|---|---|
| signals-dpg | New routes under `/api/v1/aggregator/item/verification`: get status and attributes, submit a check, get the token |
| signals-dpg | New public route `GET /.well-known/jwks.json` |
| signals-dpg | A `verification` summary on onboarding responses (`/admin/participant`, self-register, link / QR submission) |
| signals-dpg | `POST /api/v1/admin/participant`: an optional `verification` block for CSV rows uploaded with the checkbox ticked |
| signals-dpg | A `verification` summary on profile reads, admin participant reads, and dashboard/export |
| signals-dpg | Dashboard/export: all lifecycles plus `account_only`, and a `verification_status` filter |
| aggregator-dpg | New Signals client methods, API and BFF routes for individual verification |
| aggregator-dpg | Upload-start: the optional verification checkbox (`consent.json` document and ledger entry). The worker sends the `verification` block |
| aggregator-dpg | Dashboard/export: widened `lifecycle` filter, verification status passthrough, and per-row verification outcome in bulk-upload results |
| aggregator-dpg | **`profiles.verify` and `profiles.view_pii` granted to the built-in `coordinator` role by default**, via a new RBAC seed migration |

## UI (planned after this design is shared)

- **aggregator-dpg:** the verification screen, the verification checkbox on CSV upload, status badges and filters on the dashboard, and the warnings in bulk-upload results.
- **Signals UI:** the participant's verification status.

The APIs above already return everything these screens need.

## Breaking changes

**None on the wire.** All API and DB changes are additive, the new response fields are optional, and the Signals dashboard default is unchanged.

**Behaviour change on domains that switch the gate on:** new profiles from every channel (CSV, self-register, link / QR, voice) stay `draft` until verified, unless a CSV upload with the checkbox ticked verifies them. A live profile whose verified attribute changes returns to `draft`. Run the exemption script first.

Things to be aware of:

- **New required secret for issuing tokens.** If `VERIFICATION_SIGNING_KEY` is not set, issuing fails with `VERIFICATION_SIGNING_UNAVAILABLE`. Everything else keeps working.
- **Every coordinator gains `profiles.verify` and `profiles.view_pii`.** This is a permission increase for all existing and new coordinators; `profiles.view_pii` is otherwise a time-limited grant (90 days, `pii_access` role).
- **The aggregator portal will list more users** (paused, retired, account-only), so its counts and pages change.
- **aggregator-dpg starts writing to Signals beyond bulk create.** Its docs need updating.

## Further enhancements (after v1)

**Multi-select verification.** Select several profiles in the portal and confirm them in one go, with a batch-size limit enforced by the API. The CSV verification checkbox is already in v1.

**Rejection flow.** A verifier rejects an attribute, the participant sees it highlighted on their details page, corrects it, and the attribute goes back for re-checking. The `attribute_checks` jsonb can carry a `rejected` decision later without a schema change.

**Verified status on the map.** To be picked up once v1 is complete.

- Signals publishes an item event when a verification is issued or revoked, so signals-search re-indexes the profile.
- signals-search (separate repo) adds a verified field to `item_search`. The native fallback path reads `profile_verifications` directly.
- The `/markers` response carries the verified flag, and the map pin shows the verified icon.
- The same indexing also makes it possible to show the icon on search/discover results later.
