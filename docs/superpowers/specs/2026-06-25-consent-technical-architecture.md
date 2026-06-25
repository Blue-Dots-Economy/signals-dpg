# Consent Management — Technical Architecture (for System Architect)

**Date:** 2026-06-25 · **Audience:** System Architect
**Source of truth:** [`2026-06-25-consent-management-design.md`](./2026-06-25-consent-management-design.md) (full design)
**Status:** Design — pending review

> This is the *technical* view: topology, data, contracts, sequences, scale, and migration. For user-facing journeys see the companion **Functional Design** doc.

## 1. Context & constraints

- Two DPGs today with **different IdPs** — Signals = better-auth, aggregator = Keycloak. **Hard prerequisite:** converge both onto **Keycloak**; every consent principal is identified by the Keycloak **`sub`**.
- Infra reused: **shared RDS** (per-service DB+user), **common Redis**, **notification-service** (email/SMS/WhatsApp), service-to-service HMAC (the `dpg-scoring` pattern).
- Standards binding: **DPDP**, **ISO/IEC 29184 + Kantara consent receipt**, **W3C DPV**, **DEPA** consent artefact.

## 2. Component topology

```
                         ┌───────────────────────────────────────────┐
                         │              consent-service                │
                         │   Fastify + Zod + Drizzle (own DB+user)     │
                         │                                             │
   keyed on Keycloak sub │  consent_document  consent_record           │
                         │  consent_principal erasure_request          │
                         │  /consent/* + /admin/consent/*              │
                         └───▲────────▲───────────▲───────────▲────────┘
                             │HMAC    │HMAC        │HMAC       │HMAC
              ┌──────────────┘  ┌─────┘      ┌─────┘     ┌─────┘
        ┌─────┴─────┐   ┌───────┴────┐  ┌────┴─────┐ ┌───┴─────────────┐
        │ Signals   │   │ Signals UI │  │aggregator│ │ voice bot       │
        │ API       │   │ (Keycloak  │  │ -dpg     │ │ (ai-diffusion / │
        │ (gate +   │   │  session)  │  │(operator │ │  trust layer)   │
        │  capture) │   │            │  │ +onboard)│ │                 │
        └─────┬─────┘   └────────────┘  └────┬─────┘ └─────────────────┘
              │                              │
   shared RDS · common Redis (consent:* cache + pub/sub) · notification-service (OTP)
```

- **Single central service** (not per-aggregator) because consent spans aggregators and keys on the global `sub`. This shape also aligns with the planned "central store + mutual auth" remediation for the inter-instance trust gap.
- **Data residency:** keep the consent DB in-region (DPDP → India).

## 3. Data model (Drizzle / Postgres)

| Table | Purpose | Key columns |
|---|---|---|
| `consent_document` | versioned, immutable content | scope key = `network`+`audience`+`doc_type`+`action_type?`+`action_status?`+`channel?`, `version`, `content` (sanitized GFM), `data_captured`/`purpose` (DPV jsonb), `retention_duration`, `consent_validity_duration`, `is_active`, `language` |
| `consent_record` | append-only acceptance ledger (= consent receipt) | `seq` (bigserial, ordering), `receipt_id`, `subject_id` (sub), `document_id`+`document_version`, `event` (`accepted`\|`revoked`\|`erasure_requested`\|`erased`), snapshotted purpose/retention, `expires_at`, `source`, `channel`, `filler`+`filler_meta`, `confirmation_status`, `org_id?`, `action_id?`, `consent_artefact` (DEPA jsonb) |
| `consent_principal` | per-subject facts | `subject_id` PK, `date_of_birth`, `is_minor`, `guardian_contact*`, `guardian_verified` |
| `erasure_request` | resumable deletion fan-out | `subject_id`, `status`, one tracked target row per `{signals, aggregator_db, search_index, aggregator_offline_email}` with status/attempts/evidence |

**Invariants:** `consent_document` — `UNIQUE(scope key, version)` + partial-unique **one active per scope key** `WHERE is_active`; publish computes `version=max+1`, retries on `23505`. `consent_record` — append-only; "current state" = latest by `seq` (never timestamps); idempotent accept via transactional read-check-write (no unique index, so re-accept-after-revoke is allowed). Index `(subject_id, network, audience, doc_type, seq desc)`. Ledger grows → **partition** by network/month + archival.

## 4. API surface

- **Public:** `GET /consent/active?network=&audience=`
- **Auth (session/service):** `GET /consent/status` (→ `needs_consent`, `is_minor`, `guardian_consent_required`), `POST /consent/accept` (carries exact `document_id`; TOCTOU → `409 STALE_CONSENT_VERSION`), `POST /consent/revoke`, `GET /consent/receipt/:id`
- **Voice:** `POST /consent/voice/capture`, `POST /consent/voice/confirm`
- **Guardian:** `POST /consent/guardian/request-otp` (rejects self-contact; rate-limited), `POST /consent/guardian/verify`
- **Erasure:** `POST /consent/erase`, `GET /consent/erase/:id`
- **Admin:** `POST /admin/consent/documents` (publish), `GET /admin/consent/documents`

`network` is **always server-derived**; never trusted from the body. Routes never throw — `{ error, message }` with machine-readable codes; handle `23505`/`23503`.

## 5. Enforcement model (key architectural change)

- **Account-T&C gate fires at user creation / Keycloak provisioning** — *not* a per-write preHandler. This removes a per-write network hop. The better-auth→Keycloak migration provisioning is itself a gate trigger.
- **Re-consent** (version/expiry/revoke) enforced at the **login / present turn** via `GET /consent/status` (UI modal / voice prompt), not by blocking writes.
- **Action-consent gate** at action-perform (connect/apply), **fail-closed** for PII-revealing actions.
- **Presence classification** per request: `present` (UI session \| live voice) → gate/capture; `on_behalf` (aggregator proxy \| bulk) → never gated. "Consent pending" is simply the absence of a current `accepted` row.

## 6. Key sequences

**Capture at signup/provisioning**
```
UI/Keycloak → consent-service GET /active → render → POST /accept(document_id)
  → TOCTOU check active → write accepted row(s) + receipt + DEPA artefact + expires_at
```

**Re-consent at login**
```
login → GET /status → needs_consent? → blocking modal(change_summary) → POST /accept
```

**Voice (async, no held call)**
```
voice → POST /voice/capture (verbal, unverified) → [call ends]
  → notification-service OTP/link → user → POST /voice/confirm → verified
```

**Action gate**
```
action/perform → check action_consent(network,action_type,status) → fail-closed if missing
  → else proceed; PII reveal tied to status transition (replaces reveals_pii_on_status)
```

**Erasure fan-out (resumable)**
```
POST /erase → open erasure_request + append erasure_requested
  ├─ Signals: delete item_state/private_state/actions (legal-hold)
  ├─ aggregator: delete participants/link_submissions
  ├─ search: rely on existing purge worker (or explicit purge) — avoid pgvector path
  └─ aggregator-offline: notification-service email → require acknowledgement
  → append erased; ledger row retained as proof
```

## 7. Scale & resilience

- **Caching:** `GET /status` cached in Redis (`consent:*`), invalidated via **event-driven pub/sub** on accept/revoke/publish (not just TTL) → steady-state checks are local reads.
- **Fail policy:** fail-closed for PII-revealing action consent; fail-open-within-TTL for non-critical checks.
- **Throughput:** no per-write hop (gate at creation); action checks are less frequent and cache-backed.
- **Availability:** consent-service on the PII-action critical path → size for HA; cache absorbs brief outages within TTL.
- **OTP capability flag:** every OTP step checks per-instance SMS/SMTP availability → `verified` vs `unverified`; notification-service rate-limits apply (anti-bombing).

## 8. Security

- Service-to-service **HMAC**; principal identity is the Keycloak `sub` (no cross-DB user FK once converged).
- `content`/`change_summary` rendered with a **sanitizing GFM renderer** (public pages) — raw HTML stripped.
- Guardian contact must not equal the user's own verified contact. DOB/guardian are self-attested (documented residual risk; not identity verification).

## 9. Migration & deployment

- **Prereq:** Keycloak convergence; integrations cut over per-DPG.
- **No backfill** — re-prompt at next present turn; seed v1 docs per network.
- **Signals:** stop hardcoding `terms_accepted`/`privacy_accepted` in `participant.ts`; deprecate booleans (no response-shape change); relax schema to optional.
- **Aggregator:** operator registration calls the service; migrate `aggregators.consent`; persist the previously-discarded QR/voice consent; stop sending `presume_consent` as user consent.
- **Retire** the old `consent_text_*` / `ConsentAck` / `reveals_pii_on_status` mechanism once `action_consent` is live.

## 10. Standards mapping

| Standard | Where it lands |
|---|---|
| DPDP 2023 + Rules | affirmative-action capture, itemized notice (`data_captured`/`purpose`), `/revoke`, erasure, guardian OTP, `language` (English + 22 scheduled), grievance hook |
| ISO 29184 + Kantara | `consent_record` issued as a consent receipt (`receipt_id`), `GET /consent/receipt/:id` |
| W3C DPV | controlled-vocabulary terms in `purpose`/`data_captured` |
| DEPA | `consent_artefact` projection (purpose, data-filter, frequency, validity, signature) |

## 11. Dependencies & risks

- **Keycloak convergence** (blocking prerequisite; separate project).
- **Erasure × search index** — reuse the proven purge worker; do **not** add deletion logic onto the unstable pgvector path (known AVX-512 SIGILL).
- **Central-service availability** on the PII-action path — mitigated by HA + cache.
- **Self-attested DOB/guardian** — accepted residual risk in v1.

## 12. Phasing (each = one branch/plan)

1. Consent service core (schema, active/status/accept/revoke, admin publish, receipt/DPV/DEPA, cache+invalidation)
2. Signals integration (creation-time gate, login re-consent, voice endpoints, `/privacy` `/terms`)
3. Per-action consent (`action_consent` docs; rework/retire `reveals_pii_on_status`)
4. Aggregator integration (operator terms, QR/voice/bulk capture, proxy metadata)
5. Minors (DOB + guardian + capability-gated OTP + guardian re-consent on version bump)
6. Lifecycle (stop-processing + full erasure fan-out + legal-hold)
