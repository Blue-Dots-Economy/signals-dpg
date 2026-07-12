---
paths:
  - "apps/api/src/routes/v1/consent/**"
  - "apps/api/src/services/consent_*.ts"
  - "apps/api/src/services/item_service.ts"
  - "packages/schemas/src/consent_config.ts"
  - "packages/schemas/src/api/consent_schemas.ts"
  - "packages/config/src/consent_config_loader.ts"
---

# Consent (v1)

Consent is an **append-only ledger** (`consent_record` table). Latest event per `(subject, type)` wins by `seq`, never by timestamp. Content is never stored in the row — only `(category, version)`; the text is resolved from `consent.json`. Levels:

- **user** — `terms` / `privacy` (keyed on `user_id`), via `/api/v1/consent`.
- **item** — `profile_creation` (keyed on `item_id`; idempotent via a partial unique index) and `action` rows (keyed on `item_id` + `action_id`, with `action_type` / `action_stage`).

Two invariants worth internalising:

- **Version is derived server-side.** Never trust a client-supplied version integer. `apps/api/src/services/consent_version.ts` (`resolveConsentVersion`) reads the cached config for the `(network, brand, category[, actionType, stage])` tuple and records that. A client cannot record acceptance of a version the user never saw.
- **Consent copy lives in `consent.json`, not `network.json`.** Each network's `consent.json` sits beside its `network.json` (brand overrides in a brand-named sub-folder), is loaded via `CONSENT_CONFIG_SOURCE` (`local` default; remote is a follow-up returning `[]`), and is cached as `consent_config` entries alongside network schemas (`network_schema_cache.ts`). This **replaced** the inline `consent_text_initiator` / `consent_text_receiver` fields that used to live in `network.json` action definitions — do not reintroduce them. See `packages/config/CLAUDE.md` for the loader's brand-override and `__SUPPORT_EMAIL__` substitution mechanics.
- **Support email is a placeholder, not a literal.** Consent copy ships a `__SUPPORT_EMAIL__` token (T&C/Privacy/Grievances); the consent loader renders it to `CONSENT_SUPPORT_EMAIL` (default `hello@bluedotseconomy.org`) at load, so the address is deploy-time configurable without editing consent content (#266). Distinct from `SUPPORT_EMAIL` (the contact-form recipient). Deployed instances may also have it substituted upstream at ConfigMap render.

`create_item` accepts an optional `consent` block to capture profile-creation consent atomically with the profile. `perform_action` / `update_action_status` gate on action-consent at `initiate` / `accept` stages.

**Consent gates discoverability.** A profile is only network-visible (`lifecycle_status = live`) when its required fields are complete **and** `profile_creation` consent is accepted. Accepting profile consent (`routes/v1/consent/accept_profile_consent.ts`) calls `promoteItemOnProfileConsent` (`services/item_service.ts`), which re-runs the same `classify_item` completeness classifier used on write — with `consent_accepted: true` — and flips a `draft` item to `live`. Only `draft` is promoted: `paused` is sticky and `live` needs no change. Keep the completeness rules in the classifier, not duplicated in the consent path. The deploy migration for existing rows is a one-off backfill, `pnpm db:backfill:consent:api` (`apps/api` `db:backfill:consent`).
