# Consent Management System — Cross-DPG Design

**Date:** 2026-06-25
**Supersedes / builds on:** `2026-06-18-consent-management-design.md` (Signals-only, account-T&C draft on `feat/consent-management`)
**Issue:** Consent upgrades — versioned consent + audit ledger + multi-channel capture + per-action consent + under-18 guardian consent + withdrawal/erasure, spanning **Signals-DPG** and **aggregator-dpg**
**Status:** Design — pending user review before the implementation plan(s)

---

## 1. Goal

Replace today's scattered, untrustworthy consent state — two booleans on the Signals `user` table, a hardcoded `presume_consent` flag pushed by the aggregator, a discarded checkbox on the voice/QR form, and an inline-logged-but-not-stored per-action acknowledgement — with a **single, first-class, versioned, auditable consent system shared across both DPGs and all channels**:

- immutable **versioned consent documents** (privacy / terms / operator-terms / per-action statements) per network;
- an append-only **per-subject acceptance ledger** recording *what data / for what purpose / for how long / on which channel / verified or not*, shaped as a standards-aligned **consent receipt**;
- the **capture, gate, re-capture, revoke, expire, and erase** flows across **UI, voice bot, aggregator proxy, and bulk**, including a **guardian-consent path for under-18 users** and a **full cross-service erasure** workflow.

## 2. Architecture decision — a standalone shared consent service

**`consent-service`** is a new, independently-deployable **Fastify + Zod + Drizzle** service (consistent with the rest of the monorepo), and the **single system of record** for all consent across the ecosystem.

- **Identity key — Keycloak `sub`.** Every consent principal (participant *or* operator) is identified by its Keycloak subject id.
  - **Prerequisite (hard):** both DPGs converge onto **Keycloak** as the shared IdP. Today Signals uses better-auth and aggregator uses Keycloak; they do not share an IdP. The consent service is built against `sub`, and each DPG's integration lights up as it cuts over to Keycloak.
- **Two audiences:** `participant` (Signals end-users) and `operator` (aggregator org admins) — same machinery, different document sets.
- **Consumers (HTTP clients):** Signals API, Signals UI, aggregator-dpg (API + portal), and the voice bot. Service-to-service auth via HMAC/service keys (the `dpg-scoring` pattern already in the monorepo).
- **OTP is not owned here.** The service calls **notification-service** (email/SMS/WhatsApp) for all OTP sends, governed by a per-instance **provider-configured flag** (see §7).
- **Infra (reuses what exists):**
  - **DB:** its own database + DB user on the **shared RDS** (per-service pattern). It is **one consent DB**, not per-aggregator — consent spans aggregators and is keyed on the global `sub`.
  - **Redis:** the **common Redis**, namespaced `consent:*`, for the status cache **and** an **event-driven pub/sub invalidation** channel (publish on accept/revoke/publish so consumers keep a warm local cache rather than hitting the service per check).

### 2.1 Scale & resilience notes

- **No per-write gate hop.** The account-T&C gate fires at **user creation/provisioning** (§5), not on every item/action write, so the steady-state path is not a per-write network call. Re-consent is enforced at the login/present turn. Action consent is checked at action-perform (less frequent than ordinary writes).
- **Availability / fail policy:** **fail-closed** for PII-revealing action consent; **fail-open within cache TTL** for non-critical checks. Explicit, documented.
- **Federation / cross-network instances:** a single central service keyed on `sub` is the right shape and aligns with the planned "central store + mutual auth" fix for the inter-instance trust gap. Watch **data residency** (DPDP → India region). The append-only ledger grows → **Postgres partitioning** (by network or month) + archival; the "latest event by `seq` per (subject, scope)" lookup stays index-backed.

## 3. Standards anchored as design constraints

All four are binding design inputs (not just future interop):

- **DPDP Act 2023 + draft Rules (India)** — consent must be free, specific, informed, unambiguous, by **clear affirmative action**; **itemized notice** (what data / what purpose); **withdraw as easily as given**; **right to erasure**; **verifiable parental consent for under-18**; notice available in **English + the 22 scheduled languages**; grievance redressal. Also aligns the service toward the DPDP **Consent Manager** shape (interoperable, accountable to the data principal).
- **ISO/IEC 29184:2020 + Kantara Consent Receipt** — every acceptance issues a **consent receipt** (`receipt_id`; who / what data / purpose / duration / third parties), retrievable via API.
- **W3C DPV (Data Privacy Vocabulary)** — `purpose` and `data_captured` use DPV controlled-vocabulary terms (machine-readable), not freeform strings.
- **DEPA electronic-consent artefact (India)** — the record carries a **DEPA-compatible consent-artefact** projection (purpose, data-filter, frequency, validity, signature) for Account-Aggregator / Sahamati-ecosystem interop.

(GDPR is the same shape if EU exposure ever arises. IAB TCF / adtech is out of scope.)

## 4. Data model

All columns snake_case; Postgres via Drizzle; never hand-edit migrations.

### 4.1 `consent_document` — versioned, immutable content

One row per published version; `is_active` is the **only** mutable column.

**Scope key** (what a document applies to): `network` + `audience` + `doc_type` + `action_type?` + `action_status?` + `channel?`.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `network` | text NOT NULL | per-network |
| `audience` | text NOT NULL | `participant` \| `operator` |
| `doc_type` | text NOT NULL | `privacy_policy` \| `terms_of_service` \| `operator_terms` \| `action_consent` |
| `action_type` | text NULL | set **only** for `action_consent` (e.g. `connect`, `apply`) |
| `action_status` | text NULL | optional, when the statement varies by status (e.g. the PII-revealing `accepted` transition) |
| `channel` | text NULL | **null = all channels** (always null in v1; reserved for future channel-specific statements with no schema change) |
| `version` | int NOT NULL | monotonic per scope key |
| `title` | text NOT NULL | |
| `content` | text NOT NULL | sanitized **GFM Markdown** (raw HTML stripped — it renders on public pages) |
| `change_summary` | text NULL | author "what's new", Markdown, shown only in the re-consent modal |
| `data_captured` | jsonb NOT NULL | **what data** — DPV vocabulary terms |
| `purpose` | jsonb NOT NULL | **for what purpose** — DPV vocabulary terms |
| `retention_duration` | interval NULL | **how long data is kept** — informational statement; does **not** drive consent expiry |
| `consent_validity_duration` | interval NULL | **consent TTL** — drives `expires_at`; distinct from retention; NULL = no time-expiry |
| `is_active` | boolean NOT NULL default false | the active tag — `active = required` |
| `language` | text NOT NULL default `'en'` | one language per version (English + 22 scheduled languages over time) |
| `created_at` | timestamptz default now() | |
| `created_by` | text NULL | publisher Keycloak `sub` / org id |

- **Immutability:** content rows are never updated; publishing a new version inserts a row and, in one transaction, flips `is_active` off the prior and on the new.
- **Invariants:** `UNIQUE (scope key, version)`; **partial unique** `UNIQUE (scope key) WHERE is_active` — exactly one active per scope key.
- **Publish concurrency:** `version = max+1`; on `23505` collision, **retry** (recompute), never 500.
- **Dynamic set:** the active rows for a `(network, audience)` are the source of truth for which docs apply; `GET /consent/active` returns exactly those.

### 4.2 `consent_record` — append-only acceptance ledger (the audit trail & consent receipt)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `seq` | bigserial NOT NULL | **authoritative event order** — "latest event" tiebreaker (never timestamps) |
| `receipt_id` | text NOT NULL | ISO 29184 / Kantara **consent-receipt** id |
| `subject_id` | text NOT NULL | Keycloak `sub` of the consenting principal |
| `network` | text NOT NULL | **server-derived** (never trusted from body) |
| `audience` | text NOT NULL | `participant` \| `operator` |
| `doc_type` | text NOT NULL | + `action_type` / `action_status` for action consent |
| `document_id` | uuid NOT NULL → `consent_document.id` | **the exact version the client rendered** (TOCTOU-guarded) |
| `document_version` | int NOT NULL | denormalized snapshot |
| `event` | text NOT NULL | `accepted` \| `revoked` \| `erasure_requested` \| `erased` |
| `data_captured` / `purpose` / `retention_duration` | jsonb / jsonb / interval | **snapshotted** at acceptance (self-contained for audit) |
| `accepted_at` | timestamptz NOT NULL | event time |
| `expires_at` | timestamptz NULL | `accepted_at + consent_validity_duration` (NULL = no time-expiry) |
| `source` | text NOT NULL | `signup` \| `login_reconsent` \| `onboarded_first_login` \| `guardian` \| `action` \| `operator_registration` |
| `channel` | text NOT NULL | `ui` \| `voice` \| `aggregator` \| `bulk` |
| `filler` | text NULL | `self` \| `proxy` (form capture) |
| `filler_meta` | jsonb NULL | proxy relationship / identity, for audit |
| `confirmation_status` | text NOT NULL | `verified` \| `unverified` (OTP-capability outcome) |
| `org_id` | text NULL | acting org (operator / proxy / onboarding context) |
| `action_id` | text NULL | links per-action consent to the `item_action` |
| `consent_artefact` | jsonb NULL | **DEPA-compatible** projection (purpose, data-filter, frequency, validity, signature) |
| `ip` / `user_agent` | text NULL | optional audit fields |

- **Append-only & idempotent.** Latest event by `seq`. Accept is a transactional **read-check-write** (no unique index — re-accept after revoke must be allowed). One row per accepted `doc_type`/scope (two docs active ⇒ two rows).
- Index: `(subject_id, network, audience, doc_type, seq desc)` for latest-event lookup.

### 4.3 `consent_principal` — small per-subject record

`subject_id` PK, `date_of_birth`, `is_minor` (derived), `guardian_contact?`, `guardian_contact_type?` (`phone`\|`email`), `guardian_verified` bool. DOB is authoritative in the IdP/user record and mirrored here so the service computes `guardian_consent_required` without a cross-service call per status check. Guardian contact must not equal the user's own verified contact.

### 4.4 `erasure_request` — auditable, resumable deletion fan-out

`id` PK, `subject_id`, `requested_at`, `status` (`open` \| `complete` \| `partial`), and **one tracked target row per destination** (`signals`, `aggregator_db`, `search_index`, `aggregator_offline_email`) each with `status`, `attempts`, `completed_at`, and `evidence` (e.g. the aggregator's deletion acknowledgement). Legal-hold carve-outs recorded per target.

### 4.5 Provenance for non-consent onboarding (bulk)

Bulk onboarding writes **no `accepted` row** (the user performed no affirmative action — recording one would fabricate consent and fail DPDP). Instead it records an **onboarding/provenance note** (`onboarded via bulk by org X, no participant consent captured`). The user therefore reads as `needs_consent` and is captured at the next present turn. *(Decision: provenance-not-fabricated-accept; revisit only if uniformity is explicitly preferred over ledger truthfulness.)*

## 5. Channel flows & presence-based gating

**Presence classification** (set by each consumer per request):
- **`present`** — principal acting for themselves in a live authenticated turn: Signals UI (Keycloak session) or voice bot (live call, caller identified).
- **`on_behalf`** — integrator acting for the principal: aggregator proxy writes, bulk.

"Consent pending" is **not** a stored flag — it is simply the absence of a current `accepted` record, so `GET /consent/status` returns `needs_consent` until a present turn captures it.

### 5.1 Gating model (revised — creation-time, not per-write)

- **Account-T&C gate = at user creation / provisioning in Keycloak** (self-signup *and* the better-auth→Keycloak migration provisioning). **Not** a per-item-write preHandler.
- **Re-consent** (version bump / expiry / revoke) is enforced at the **login / present turn** — UI blocking modal or voice prompt via `GET /consent/status` — not by blocking individual writes.
- **Action-consent gate = at action-perform** (connect/apply): requires a valid `action_consent` acceptance for `(network, action_type, status)`. **Fail-closed.**
- `on_behalf` creation and public routes are never gated. Reads stay open.

### 5.2 Per-channel behavior

| Channel / event | Behavior | Ledger |
|---|---|---|
| **Signals UI — self-signup** | DOB + required T&C checkbox (docs from `/consent/active`); record on account creation | `accepted`, source `signup`, channel `ui`, filler `self` |
| **Signals UI — returning login** | `/status`; if `needs_consent` → blocking modal w/ `change_summary` | `accepted`, source `login_reconsent` |
| **Voice bot turn** | bot hits a consent endpoint; **strategy configurable** (see §5.3) | `accepted`, channel `voice`, `verified`\|`unverified` per strategy |
| **Aggregator QR/link — self** | trust the captured checkbox (v1); **unverified** until OTP | `accepted`, channel `aggregator`, filler `self`, `unverified` |
| **Aggregator QR/link — proxy** | proxy-asserted; **unverified** until OTP re-confirm | `accepted`, filler `proxy` + `filler_meta`, `unverified` |
| **Bulk CSV** | no affirmative action → **no `accepted` row** | provenance note only → `needs_consent` |
| **Per-action (connect/apply)** | render active `action_consent` doc; accept at perform; PII-revealing receiver consent at the status transition | `accepted`, source `action`, `action_id` |
| **Operator (aggregator registration)** | aggregator registration calls the service | `accepted`, audience `operator`, source `operator_registration`, `org_id` |

### 5.3 Voice capture — configurable verification strategy (decouples verification from call cost)

Per-instance/adopter setting:
- **`async_confirm`** *(default where a provider exists)* — capture **verbal acceptance in-call, recorded immediately as `accepted` + `unverified`**; send OTP/confirmation link to the registered phone/email for **out-of-band** confirmation **after** the call (no held minutes). `confirmation_status` flips to `verified` on confirm; the user is not blocked meanwhile.
- **`in_call_otp`** — read the OTP back during the call (holds the call). Opt-in only.
- **`verbal_trust`** — verbal acceptance only, stays `unverified` (no provider configured).

## 6. Per-action consent

Versioned `action_consent` documents keyed by `(network, action_type, action_status?)`, authored via the admin publish API, snapshotted into the ledger at acceptance with `action_id`. v1 reuses one statement across channels (`channel` null); the dimension is reserved for future channel-specific statements.

This **supersedes** the inline `consent_text_initiator` / `consent_text_receiver` + `ConsentAck` mechanism. We **rework `reveals_pii_on_status`** to be driven by the consent service (PII reveal requires the relevant `action_consent` acceptance) and **retire** the old consent-text fields/table once the service is live.

## 7. OTP — capability-gated, never a hard dependency

OTP send infra is per-instance (adopters bring their own SMS/SMTP, and frequently lack SMS). So **every OTP-dependent step checks a provider-configured flag** (SMS for phone, SMTP for email):

- provider present → run the **verified** flow (guardian OTP, proxy re-confirm, voice `async_confirm`/`in_call_otp`) → `confirmation_status = verified`;
- provider absent → **degrade gracefully** to trusting the declaration → `confirmation_status = unverified`.

Same code path everywhere; the flag decides verified-vs-trusted. Existing notification-service rate-limiting **must** apply (OTP send is an SMS/email-bombing vector). DPDP "verifiable parental consent" is satisfied wherever capability exists; the `unverified` gap is a documented residual risk.

## 8. Minors / guardian consent

- Capture **DOB** at the present turn; the service computes `is_minor` and `guardian_consent_required`.
- If `<18`: collect guardian details (name, contact, relationship) + a guardian-consent declaration.
  - provider present → **guardian OTP** → `source=guardian`, `verified`;
  - provider absent → trust declaration → `unverified`.
- **Version bump for a returning minor → the guardian re-consents** (re-OTP the stored contact where capable). The guardian is the legal consenter, so `needs_consent`/re-consent for a minor keys off the **guardian's** versioned record, and a version bump re-opens the guardian flow.
- **Residual risk (documented, not solved):** DOB is self-reported and guardian contact is self-attested. Mitigations: separate OTP where capable; guardian contact ≠ the user's own verified contact. This is not identity verification.

## 9. Lifecycle — expiry, withdrawal, erasure (full, v1)

Three escalating states, all in v1:

- **Re-gate** — `revoked` or expired (`now > expires_at`, computed lazily — no cron) → `needs_consent` → re-captured at next present turn.
- **Stop-processing** — withdrawal **pauses visibility/processing** of the user's existing items & actions (retained, not visible/connectable).
- **Erasure** — coordinated, auditable, **resumable** fan-out via `erasure_request`, one tracked target per destination:

| Target | Action | Completion evidence |
|---|---|---|
| **Signals** | delete `item_state`, `item_private_state`, actions (honoring legal-hold) | per-target status + timestamps |
| **aggregator-dpg** | delete `participants`, `link_submissions` | per-target status |
| **search index** | **reuse the existing purge worker** (Signals deletes item rows → worker sweeps & purges vectors); explicit-purge call optional for immediacy. Avoids new logic on the fragile pgvector path | worker/purge confirmation |
| **onboarding aggregator(s) — offline copies** | **email via notification-service** requesting deletion of off-system copies | **sent → acknowledged**; aggregator attests deletion; unacknowledged = open compliance item |

**Principles:** the **consent ledger is never erased** (legal proof); `erasure_requested`/`erased` events are appended; **legal-hold carve-outs** retain what law requires; a failed target retries without redoing completed ones.

## 10. API endpoints

Fastify + Zod; snake_case route exports; machine-readable `error` codes; never throw across boundaries. Service-to-service via HMAC/service key; `network` is **always server-derived**.

**Public / participant:**
- `GET /api/v1/consent/active?network=&audience=` — **public** (pre-login). Returns active docs (0..N of the applicable set) for rendering.
- `GET /api/v1/consent/status` — auth. Per `doc_type`: accepted version (if any), `needs_consent`, `is_minor`, `guardian_consent_required`. Single source of truth for gating.
- `POST /api/v1/consent/accept` — auth. Body carries the **exact `document_id` rendered** + `accept:true` (+ `channel`, `filler`, `filler_meta`). **TOCTOU guard** → `409 STALE_CONSENT_VERSION` if no longer active. Writes one `accepted` row per active doc (snapshot + `receipt_id` + `consent_artefact` + `expires_at`) via idempotent read-check-write.
- `POST /api/v1/consent/revoke` — auth. `{ doc_type }` → `revoked` event → re-gate + stop-processing.
- `GET /api/v1/consent/receipt/:id` — auth. Returns the ISO 29184 / Kantara consent receipt.

**Voice:**
- `POST /api/v1/consent/voice/capture` — service-auth. Records verbal acceptance (`unverified`) and, per strategy/capability, triggers the out-of-band OTP/link. `POST /api/v1/consent/voice/confirm` flips to `verified`.

**Guardian (capability-gated):**
- `POST /api/v1/consent/guardian/request-otp` — rejects guardian contact = user's own; subject to notification-service rate limits.
- `POST /api/v1/consent/guardian/verify` — persists `guardian_contact*`, writes `guardian`-source acceptance.

**Erasure / withdrawal:**
- `POST /api/v1/consent/erase` — auth. Opens an `erasure_request`, appends `erasure_requested`, kicks the fan-out. `GET /api/v1/consent/erase/:id` reports per-target status.

**Admin publish:**
- `POST /api/v1/admin/consent/documents` — publish a version (insert `max+1`, activate, deactivate prior; retry on `23505`); `created_by` = acting admin/org. `GET …/documents?…` lists versions.

## 11. Migration & backward compatibility

- **Prerequisite:** Keycloak convergence (both DPGs). Integrations cut over per-DPG.
- **No backfill** — re-prompt everyone at next present turn (truthful ledger). Seed `v1` active docs per network (dev seed under `apps/api/scripts/`).
- **Signals:** stop hardcoding `terms_accepted`/`privacy_accepted` in `participant.ts`; deprecate the booleans (read paths move to the service; columns removed in a later cleanup); relax `participant.ts` schema booleans to optional. **No existing API response shape changes** (nothing returns those booleans today).
- **aggregator-dpg:** operator registration calls the service (audience `operator`); migrate existing `aggregators.consent` rows in; persist the QR/voice form's previously-discarded consent (recorded `unverified`); stop sending the hardcoded `presume_consent` as if it were user consent.
- Retire the old `consent_text_*` / `ConsentAck` / `reveals_pii_on_status` mechanism once `action_consent` is live.

## 12. Testing

- **Pure/unit:** `needs_consent` logic (no record / revoked / older version / expired / onboarded / minor-without-guardian); expiry computation; active-version invariant; minor detection; capability-flag branching (verified vs unverified); bulk = provenance-not-accept.
- **API/integration:** `active`, `status`, `accept` (TOCTOU 409, idempotent re-accept-after-revoke), `revoke`, voice capture/confirm, guardian request/verify, admin publish (active flip + monotonic version + one-active invariant), erasure fan-out (per-target status, resume, legal-hold), consent-receipt retrieval.
- **Cross-DPG:** operator registration → service; aggregator QR/voice/bulk capture semantics; presence classification; creation-time gate at Keycloak provisioning.
- **UI:** signup checkbox + popup; login re-consent modal; onboarded first-login prompt; minor guardian popup; `/privacy` `/terms` pages.

## 13. Phasing (each phase = one branch/plan, per the branch-per-plan workflow)

1. **Consent service core** — schema (`consent_document`, `consent_record`, `consent_principal`, `erasure_request`), `active`/`status`/`accept`/`revoke`, admin publish, receipt + DPV + DEPA shaping, Redis cache + event invalidation.
2. **Signals integration** — user-creation gate at Keycloak provisioning, login re-consent (UI + voice endpoints), `/privacy` `/terms` pages, stop hardcoding booleans.
3. **Per-action consent** — `action_consent` docs + rework `reveals_pii_on_status`, retire `consent_text_*`.
4. **Aggregator integration** — operator T&C → service, QR/link + bulk capture semantics, proxy metadata.
5. **Minors** — DOB + guardian capture + capability-gated guardian OTP + guardian re-consent on version bump.
6. **Lifecycle** — stop-processing + full erasure fan-out (incl. aggregator-offline email + acknowledgement) + legal-hold.

UI prototypes for the consent popups/dialogs are produced after this design is approved, before implementation.

## 14. Out of scope / documented follow-ups

- **Keycloak convergence itself** (prerequisite project, not built here).
- **Hard age / guardian identity verification** (DOB + guardian contact are self-attested).
- **Admin content-authoring UI** (publish is API + seed only in v1).
- **Removal** of the deprecated `terms_accepted` / `privacy_accepted` columns (later cleanup).
- **Granular / per-organization revocation** beyond the per-`doc_type` revoke shipped here.
- **Registering as a formal DPDP Consent Manager** (the service is shaped toward it; formal registration is separate).

## 15. Open questions

1. **Bulk ledger treatment** — recommended as a provenance note (no fabricated `accepted`); confirm you don't want bulk marked `unverified` for uniformity. *(Recommendation stands: provenance, for ledger truthfulness.)*
2. **Erasure legal-hold policy** — the concrete list of records/durations under statutory retention (drives the carve-out rules) needs legal input before phase 6.
3. **Voice caller authentication** — how the voice bot establishes the caller *is* the registered subject (caller-ID match vs in-call verification) for the `present` classification; interacts with the Keycloak convergence model.
