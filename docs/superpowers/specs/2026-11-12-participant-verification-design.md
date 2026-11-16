# Participant Verification — Design

**Issue:** [signals-dpg#883](https://github.com/Blue-Dots-Economy/signals-dpg/issues/883) · **Repos:** signals-dpg, aggregator-dpg · **Status:** Draft

## Summary

A coordinator from the **aggregator that onboarded the participant** verifies the participant's profile attribute by attribute. Once all required attributes are verified, Signals issues a **signed verification token**, stores it against the profile, and shows a **verified icon** in the aggregator portal and to the participant.

Verified is a separate field alongside `lifecycle_status`, not a new lifecycle stage. It is shown wherever status is shown: the aggregator dashboard and the participant's own profile. **Out of scope (v1):** map and search/discover results.

## Key details

| Topic | Decision |
|---|---|
| **Signing method** | Plain signed JWT (JWS), **Ed25519 (`EdDSA`)**, using `jose` (already a dependency of `apps/api`) |
| **Private key storage** | New env var **`VERIFICATION_SIGNING_KEY`** (PKCS8 PEM) plus `VERIFICATION_SIGNING_KID`. Declared in `packages/config/src/secrets.ts` and `turbo.json`. Sourced like other secrets: root `.env` locally, the API Kubernetes secret when deployed. One key per instance; used only by `apps/api` |
| **Public key** | Derived from the private key and published at **`GET /.well-known/jwks.json`** |
| **Expiry** | **None.** A verification stays valid until it is revoked |
| **Who can verify** | Only the aggregator that onboarded the participant (`user.onboarded_by_org_id` = acting org). The profile must be `live` |
| **What is verified** | Configured per domain in `network.json`: `verification.required_attributes` and `verification.optional_attributes` |
| **Token contents** | Issuer (the instance), the profile, the verifying org, each attribute as a **salted hash (not the raw value)**, issue time. The header carries the signing key's `kid` |
| **Where state lives** | signals-dpg only. aggregator-dpg provides the screen and calls Signals |
| **Who sees the status** | The aggregator portal (dashboard icon) and the **participant**, on their own profile in the Signals UI |

## Flow

1. **Config:** the domain lists its verifiable attributes in `network.json`. The config is rejected at load time if an attribute isn't in the item schema.
2. **Verify:** the coordinator marks each attribute verified or rejected in the portal. Signals checks ownership and `live` status, then stores the check with a hash of the current value.
3. **Issue:** when the last required attribute is verified, Signals signs and stores the token automatically.
4. **Read:** profile reads return `verification: {status, issued_at, issued_by_org_id}`. The full token comes from a separate endpoint.
5. **Revoke:** each event changes the verification as follows:

   | Event | Effect on verification |
   |---|---|
   | A verified attribute's value changes | **Revoked.** Only that attribute needs re-checking |
   | Profile retired | **Revoked** |
   | Profile paused | **No change** |

## DB changes (signals-dpg)

**One new table. No changes to existing tables.**

`profile_verifications`, with one row per profile:

| Column | Holds |
|---|---|
| `item_network`, `item_domain`, `item_id` | The profile (primary key) |
| `attribute_checks` (jsonb) | Per attribute: decision, value hash, verifying org, time |
| `status` | `in_progress`, `verified` or `revoked` |
| `token`, `kid`, `issued_at`, `issued_by_org_id` | The signed token and its details, filled once verified |

- The aggregator dashboard **joins** this table to show the icon, so no change to `item_metrics` is needed.
- Only the latest decision per attribute is kept. A full history is a v2 item if an audit trail is needed.

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
| signals-dpg | New optional `verification` field on profile reads, admin participant reads, and dashboard/export |
| signals-dpg | Participant's own profile in the Signals UI shows the verified status |
| aggregator-dpg | New Signals client methods, API and BFF routes, the coordinator verification screen, and a real value behind the existing verified icon |
| aggregator-dpg | **`profiles.verify` granted to the built-in `coordinator` role by default**, via a new RBAC seed migration |

## Breaking changes

**None.** All API and DB changes are additive, and the new response fields are optional, so older peer instances and existing clients are unaffected.

Things to be aware of:

- **New required secret for issuing tokens.** If `VERIFICATION_SIGNING_KEY` is not set, issuing fails with `VERIFICATION_SIGNING_UNAVAILABLE`. Everything else keeps working.
- **Every coordinator gains `profiles.verify`.** This is a permission increase for all existing and new coordinators.
- **aggregator-dpg starts writing to Signals beyond bulk create.** Its docs need updating.

## Open questions

1. **Coordinator identity.** Signals only knows the org. Should aggregator-dpg send the coordinator's name or id to be included in the token?
2. **Private attributes.** To verify a private field (e.g. phone), the coordinator must see its value. How is that access granted, and should each reveal be logged?
3. **Rejected attributes.** Does a rejection only block issuing, or is it also shown to the participant?
4. **Per-profile ownership (#661).** Ownership is per account today. When #661 lands, the ownership check must move with it.
