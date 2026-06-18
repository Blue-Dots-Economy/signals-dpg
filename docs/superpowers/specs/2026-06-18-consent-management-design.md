# Consent Management System — Design

**Date:** 2026-06-18
**Issue:** [#119](https://github.com/Blue-Dots-Economy/Signals-DPG/issues/119) — Consent upgrades: capture why/when/duration + audit ledger; under-18 guardian OTP
**Branch:** `feat/consent-management` (from `feature` @ 201b61e, with #187 merged)
**Status:** Design — pending user review before the implementation plan

## Goal

Replace the current boolean consent model (two columns on the `user` table, plus per-action flags) with a **first-class, versioned, auditable consent system**: immutable versioned consent documents (privacy policy / terms) per network, an append-only per-user acceptance ledger that records *what data / for what purpose / for how long*, and the UI/API flows to capture, re-capture, gate, revoke, and expire consent — including a guardian-consent path for under-18 users.

## Background — current state (verified in code)

- **Account consent = two booleans** on the better-auth `user` table: `terms_accepted`, `privacy_accepted` (default `false`), in `apps/api/db/postgres/schema/auth.ts:31-32`. No version, no timestamp, no audit.
- **Self-signup** (`apps/ui/src/pages/auth/login-page.tsx` → OTP → `apps/ui/src/pages/auth/otp-page.tsx`) captures **no** consent. The agreement is an implicit footer line in `apps/ui/src/components/layout/auth-footer.tsx` ("By continuing you agree to the Privacy Policy and Terms"), and `/privacy` `/terms` are plain `<a>` links with **no routes** in `apps/ui/src/app.tsx` → blank pages.
- **Aggregator / voice onboarding** (`apps/api/src/routes/v1/admin/participant.ts:69-70`) **hardcodes** `termsAccepted: true, privacyAccepted: true`, so onboarded users are marked consented even though they never accepted inside Signals.
- **Per-action consent** is a flag + log: `consent_text_initiator` on an interaction + `body.consent.acknowledged` (`apps/api/src/routes/v1/action/perform_action.ts:143-155`). Not a durable versioned record.
- The `user` table already carries onboarding provenance (`onboarded_via`, `onboarded_by_org_id`, `onboarded_source_id`, `onboarded_at`) and `date_of_birth` — both useful here.

## Decisions (locked with the user)

1. **Scope:** full #119 — versioned content + acceptance ledger + signup/login gating + aggregator/voice re-prompt + revocation + expiry + minors guardian-consent. **Per-ACTION consent stays as the current flag+log for now** (folded into the ledger in a later phase).
2. **Content is per-network** (each network has its own privacy/terms versions). Privacy Policy and Terms of Service are **two distinct document types**, each independently versioned with its own lifecycle (`is_active`).
   **The document set is dynamic and data-driven:** the consent docs shown and required for a network are exactly the ones that have an `is_active` row in `consent_document` for that network — a network may have only privacy, only terms, or both. There is **no separate config** (not `network.json`, not a UI config): publishing/activating a document *is* the act of enabling it. `active = required`. (`network.json` is the shared network contract; consent documents are operator/instance content — keeping them out of `network.json` avoids duplication/drift and keeps contract separate from content. If "shown but optional" is ever needed, add an `is_required` flag to `consent_document`.)
3. **Authoring:** an **admin publish API** + a **dev seed**; no content-editing UI in this scope.
4. **Onboarded users (aggregator/voice) are always prompted** to accept on first UI login — the old boolean is ignored for them.
5. **Minors:** capture **date of birth at signup**; if age < 18, a **guardian-details popup** collects a guardian **phone or email**, an **OTP** is sent to it, and on verify the guardian consent is recorded — *then* the minor is allowed in. Guardian consent is captured at **signup/login time** (covers platform use). (The issue phrased it as per-action OTP; that variant is a documented future extension — see Out of scope.)
6. **Enforcement:** server-gate sensitive writes with `403 CONSENT_REQUIRED` **and** show a blocking UI modal (server is the source of truth).
7. **Migration:** backfill a synthetic v1 acceptance for already-consented **self-signup** users (so they aren't needlessly re-prompted); **onboarded** users get no backfill (prompted).
8. **Revocation:** ship the `POST /consent/revoke` **API only** (records a `revoked` event → re-gated until re-accept). **No in-app UI** for withdraw in this scope (deferred). The `revoked` event lives in the ledger schema so granular/action-level revoke later reuses it.
9. **One consent popup, reused everywhere.** A single popup component shows the **summary** (the structured `data_captured`/`purpose`/`retention` — *not* from the markdown) on top, the **full document(s)** below as **Privacy | Terms tabs** (the rendered Markdown), and one accept checkbox. The signup checkbox's Privacy/Terms **links open this same popup on the clicked tab**; the login re-consent and onboarded gates reuse it with a banner (re-consent adds the `change_summary`). There is no separate "summary popup" vs "document popup".

## Data model

All columns snake_case; tables in `apps/api/db/postgres/schema/`; migration via `pnpm db:generate:api` (never hand-edit migration files).

### Table 1 — `consent_document` (versioned, immutable content; per-network)

| column | type | notes |
|---|---|---|
| `id` | uuid PK (`gen_random_uuid()`) | |
| `network` | text NOT NULL | per-network |
| `doc_type` | text NOT NULL | `privacy_policy` \| `terms_of_service` |
| `version` | int NOT NULL | monotonic per (network, doc_type) |
| `title` | text NOT NULL | |
| `content` | text NOT NULL | **GitHub-Flavored Markdown** body, rendered as-is (sanitized) in the popup / `/privacy` `/terms` pages. Tables, headings, lists, etc. appear only if present in the stored source. |
| `change_summary` | text NULL | author-written "what's new in this version" note — **Markdown**, rendered with the same GFM renderer as `content`; shown only in the re-consent modal (no auto-diff). Separate from `content` so the accepted legal body stays clean/immutable. |
| `data_captured` | jsonb NOT NULL | **"what details"** are captured (DPDP) |
| `purpose` | jsonb NOT NULL | **"for what purpose"** |
| `retention_duration` | interval NULL | **"for how long"** (NULL = indefinite) |
| `is_active` | boolean NOT NULL default false | the **active tag** |
| `created_at` | timestamptz default now() | |
| `created_by` | text NULL | admin who published |

- **Immutability:** content rows are never updated. Publishing a new version inserts a new row and, in one transaction, deactivates the prior active row and activates the new one. (`is_active` is the only mutable column; the textual content is immutable.)
- **Invariants:** `UNIQUE (network, doc_type, version)`; a **partial unique index** `UNIQUE (network, doc_type) WHERE is_active` enforces *exactly one active per (network, doc_type)*.
- **Dynamic set:** the **active rows for a network are the source of truth** for which consent docs apply there (0, 1, or 2 of {privacy, terms}). `GET /consent/active` returns exactly those, and the UI + `needs_consent` operate on whatever it returns — so adding/removing a document type for a network is purely a publish/deactivate action, no code or config change.

### Table 2 — `consent_record` (per-user acceptance ledger, append-only)

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `user_id` | text NOT NULL → `user.id` | |
| `network` | text NOT NULL | |
| `doc_type` | text NOT NULL | which document |
| `document_id` | uuid NOT NULL → `consent_document.id` | exact version acted on |
| `document_version` | int NOT NULL | denormalized snapshot |
| `event` | text NOT NULL | `accepted` \| `revoked` (append-only events) |
| `data_captured` / `purpose` / `retention_duration` | jsonb / jsonb / interval | **snapshotted** from the document version at acceptance, so the record is self-contained for audit even if the document changes |
| `accepted_at` | timestamptz NOT NULL | event time |
| `expires_at` | timestamptz NULL | `accepted_at + retention_duration` (NULL = no expiry) |
| `source` | text NOT NULL | `signup` \| `login_reconsent` \| `onboarded_first_login` \| `guardian` |
| `ip` / `user_agent` | text NULL | optional audit fields |

- **Append-only.** Acceptance and revocation are separate rows. The **current status** for a (user, network, doc_type) is the *latest* event by `accepted_at`. This table *is* the audit ledger.
- **Granularity — one row per accepted `doc_type`.** Accepting when **both** docs are active writes **2 rows** (one `privacy_policy`, one `terms_of_service`); only-privacy or only-terms writes **1 row**. Because the docs version/expire independently, re-consenting to one doc adds a new row for **that doc only** — the other doc's latest row stays valid (e.g. privacy v2 accepted while terms v1 remains current). Linked to the account by `user_id` → `user.id` (one user → many rows); there is no consent column on the `user` table — this ledger is the source of truth.

#### Why one row per document, not a single combined row

Acceptance is **atomic** at the UI — one checkbox, the user can't accept one document and reject the other — so two rows is **not** about allowing partial consent. We keep a row per document because the two documents are **independent artefacts** and a combined row breaks down on each of these:

- **Different metadata + different expiry.** Each document carries its own `version`, `purpose`, and `retention_duration` → its own `expires_at` (e.g. Privacy kept 12 months, Terms 24). A combined row would have to hold **two versions and two expiry dates** in one record, and "Privacy expired but Terms still valid" becomes an awkward partial state inside a single row.
- **Independent re-versioning.** Privacy can go v1→v2 while Terms stays v1. Per-doc, re-consent just **adds one new `privacy_policy` row** and leaves the `terms_of_service` row untouched and valid. A combined row must re-state the unchanged document on every re-consent and decide whether to carry its expiry forward — duplicative and error-prone.
- **Per-document audit (DPDP).** #119 requires an append-only ledger keyed by *which version of what*. "Who accepted Privacy Policy v2?" is a one-line `WHERE doc_type='privacy_policy' AND version=2`; with a combined row it means parsing a nested blob.
- **Extensible with no schema change.** Adding or removing a document type for a network is just more/fewer rows — the combined-row shape would otherwise have to change whenever the document set does.

The atomic accept still happens in a single `POST /consent/accept` call; it simply writes one row per active document.
- Index: `(user_id, network, doc_type, accepted_at desc)` for the latest-event lookup.

### `user` table changes

- Capture `date_of_birth` (column exists) at **signup**.
- Add **nullable** guardian fields (minors only; null for adults): `guardian_contact` (text — the phone or email), `guardian_contact_type` (text — `phone` \| `email`), `guardian_contact_verified` (boolean).
- `terms_accepted` / `privacy_accepted` become **deprecated** — the ledger is the source of truth. Kept temporarily (read paths move to the ledger; columns removed in a later cleanup once nothing reads them).

## API endpoints

Follow repo conventions: Fastify + Zod, snake_case route exports, machine-readable `error` codes, never throw. Request/response Zod schemas in `packages/schemas`. Admin routes use the two-header model (`x-api-key` + `x-acting-org-id`).

- **`GET /api/v1/consent/active?network=<id>`** — **public** (no auth; needed pre-login). Returns the **active** consent documents for the network — **0, 1, or 2** of `{privacy_policy, terms_of_service}`, whichever are active: `{ doc_type, version, title, content, data_captured, purpose, retention_duration }[]`. The UI renders exactly what's returned (tabs when both, single when one); drives the popups and the `/privacy` `/terms` pages.
- **`GET /api/v1/consent/status`** — auth (session). Returns, for the user's network: per `doc_type` the accepted version (if any) and a top-level `needs_consent: boolean` = true when, for any required doc_type, the latest event is missing / `revoked` / against a version older than the active one / past `expires_at`. Also returns `is_minor` and `guardian_consent_required`. This is the single source of truth for all gating.
- **`POST /api/v1/consent/accept`** — auth. Body `{ network, doc_types?: string[] }` (defaults to all active docs). Writes an `accepted` ledger row per active doc, snapshotting `data_captured`/`purpose`/`retention_duration` and computing `expires_at`. Idempotent for an already-current version.
- **`POST /api/v1/consent/revoke`** — auth. Body `{ network, doc_type }`. Appends a `revoked` event (minimal account-level withdraw → user becomes `needs_consent`).
- **Admin publish:** `POST /api/v1/admin/consent/documents` — admin. Body `{ network, doc_type, title, content (Markdown), data_captured, purpose, retention_duration, change_summary? }`. Inserts `version = max+1`, activates it, deactivates the prior (one txn). `GET /api/v1/admin/consent/documents?network=&doc_type=` lists versions.
- **Guardian OTP (minors):** reuse the existing OTP infrastructure (the login flow already supports phone **and** email OTP).
  - `POST /api/v1/consent/guardian/request-otp` — auth. Body `{ contact, contact_type }` → sends OTP to the guardian's phone/email.
  - `POST /api/v1/consent/guardian/verify` — auth. Body `{ contact, contact_type, code }` → on success, persist `guardian_contact*` on the user and write a `guardian`-source acceptance record; clears `guardian_consent_required`.

## UI flows

### 1. Signup (`/auth/login` "Create account")
- Add a **date-of-birth** field.
- Move the agreement **above the Send OTP button** as a **required checkbox**: *"I have read and agree to the Privacy Policy and Terms."* Send OTP is disabled until checked.
- The **Privacy Policy** / **Terms** links open a **popup** (modal) rendering the active content from `GET /consent/active`. The popup is driven by whatever `/consent/active` returns: **two tabs** (Privacy | Terms) when both are active, a **single scroll** when only one is, and the checkbox label adapts (e.g. "Privacy Policy and Terms" vs just one). An **Accept** in the popup ticks the checkbox. The single checkbox covers all active docs.
- The account is created at **OTP verify**, so the ledger write happens **after verify**: on successful verification call `POST /consent/accept` (source `signup`) for the active versions.
- If **DOB < 18**: after OTP verify, show the **guardian-details popup** (name + phone *or* email) → `guardian/request-otp` → guardian enters OTP → `guardian/verify` → guardian consent recorded → then into the app.

### 2. Login (returning user)
- After OTP verify (session established), the app calls `GET /consent/status`. If `needs_consent` → the **blocking consent popup** opens with a banner and the new version's **`change_summary`** ("what's new") plus the full updated document(s) in the tabs → **Accept** → `POST /consent/accept` (source `login_reconsent`) → proceed. If `guardian_consent_required` (minor, no valid guardian consent) → guardian flow. **Open question:** whether a *terms/privacy version change* for a returning minor re-triggers the **guardian** (vs the minor re-accepting) is undecided — see Open questions §1.

### 3. Onboarded (aggregator/voice) first login
- `GET /consent/status` returns no record → same blocking accept modal (source `onboarded_first_login`) before proceeding.

### 4. `/privacy` and `/terms` routes
- Add real routes in `apps/ui/src/app.tsx` rendering the active document content (reuse the popup's content component), so the footer links work as standalone pages too.

### 5. Withdraw consent — API only (no UI this phase)
- `POST /consent/revoke` exists and works (records a `revoked` event → user re-gated). The in-app "Withdraw consent" UI is **deferred**; no account-menu item is built now.

## Enforcement, revocation, expiry

- **Server is the source of truth.** A Fastify **preHandler** on sensitive **mutating** routes (item create/update, action perform) checks current consent and returns `403 CONSENT_REQUIRED` if the user lacks current consent (or, for a minor, lacks valid guardian consent). The UI blocking modal is the UX layer over the same `GET /consent/status`.
- **Scope of the gate (don't break integrators):** the preHandler applies **only to session-authenticated user actions** (a logged-in person in the UI). It does **not** apply to the **apikey / admin onboarding path** (`/admin/participant`) — the aggregator/voice DPG acts *before* the user has consented, so gating onboarding would break it. The onboarded user is instead prompted at their first Signals login.
- **Revocation:** a `revoked` event flips the user to `needs_consent` → re-gated until re-accept.
- **Expiry:** computed **lazily** in `GET /consent/status` and in the preHandler (`now > expires_at` ⇒ needs re-consent). No cron job; expiry is derived, not a stored state transition.

## Migration

- New tables `consent_document`, `consent_record`; add nullable `guardian_contact`, `guardian_contact_type`, `guardian_contact_verified` to `user`. Generate via `pnpm db:generate:api`.
- **Seed** a `v1` active `privacy_policy` + `terms_of_service` per example network (dev seed script, mirroring the existing seed scripts under `apps/api/scripts/`).
- **Backfill:** for self-signup users with `terms_accepted = true` **and** `onboarded_via IS NULL`, insert a synthetic `accepted` ledger record against the seeded v1 (source `signup`) so they aren't re-prompted. **Onboarded users get no backfill** → prompted on next login.
- Keep `terms_accepted` / `privacy_accepted` columns for now (deprecated); remove in a follow-up once no code reads them. Stop hardcoding them to `true` in `participant.ts` (so onboarded users correctly show as not-yet-consented in Signals).

## Backward compatibility & API contract impact

**No existing API response shape or value changes.** Nothing in the API returns `terms_accepted`/`privacy_accepted` (verified) — the only place they appear is `participant.ts` *writing* them to the user row. So stopping the hardcoded write changes no response.

**`POST /admin/participant` (aggregator / voice) — request stays compatible:**
- The fields `terms_accepted` / `privacy_accepted` are **kept** in the request schema so existing integrations don't break, but **relaxed from required-`true` to optional** (existing senders of `true` still pass; new callers may omit). They become **meaningless for Signals consent**.
- The aggregator's claim is **ignored for gating**: it does **not** create a `consent_record` and does **not** skip the prompt. Onboarded users are **always prompted** to accept at their first Signals login. (The claimed value may be retained as provenance — e.g. in the deprecated boolean columns or an audit note — but never substitutes for a Signals `consent_record`.)
- `participant.ts` no longer hardcodes the consent booleans on the user row.
- The onboarding write path is **not** gated by `requireConsent` (see Enforcement scope), so onboarding keeps working before the user consents.

**New behaviors (additive, not shape changes):**
- A new `403 CONSENT_REQUIRED` failure on **session-user** write paths (item create/update, action perform) when the logged-in user lacks current consent — handled by the UI consent modal. Apikey integrators are unaffected.
- Self-signup gains an optional **DOB** field on account creation and a separate `POST /consent/accept` call after OTP verify; existing auth/OTP endpoints are unchanged.

## Components / files (where changes land)

- DB: `apps/api/db/postgres/schema/consent.ts` (new tables), `auth.ts` (guardian fields); migration in `apps/api/drizzle/`.
- API: `apps/api/src/routes/v1/consent/*` (active, status, accept, revoke, guardian), `apps/api/src/routes/v1/admin/consent/*` (publish/list); a `consent_service` (status computation, accept/revoke, expiry) for testability; a `requireConsent` preHandler (session-user routes only); `participant.ts` (stop hardcoding consent booleans); `packages/schemas/src/admin/participant.ts` (relax `terms_accepted`/`privacy_accepted` to optional).
- Schemas: `packages/schemas/src/consent/*` (Zod request/response + the `needs_consent` status logic as a pure, unit-testable function).
- UI: `apps/ui/src/pages/auth/login-page.tsx` (DOB + required checkbox + popup), a `ConsentDialog`/`ConsentGate` component, `otp-page.tsx` (post-verify accept + minor flow), a login-time consent gate (in the auth context / home bootstrap), `/privacy` `/terms` pages + routes in `app.tsx`, `apps/ui/src/lib/consent-api.ts`. The one consent popup (summary + Privacy|Terms tabs of rendered Markdown + accept) is a reusable component used by signup, re-consent, and onboarded gates.
- Seed/backfill script under `apps/api/scripts/`.

## Testing

- **Pure/unit:** the `needs_consent` status function (each trigger: no record, revoked, older version, expired, onboarded, minor-without-guardian); expiry computation; active-version invariant; minor (DOB < 18) detection.
- **API/integration:** `active`, `status`, `accept`, `revoke`, admin `publish` (active flip + monotonic version + one-active invariant), guardian request/verify; the `requireConsent` preHandler returns 403 until accepted.
- **UI:** signup required-checkbox gating + popup accept; login re-consent blocking modal; onboarded first-login prompt; minor guardian popup + OTP; `/privacy` `/terms` render active content.

## Out of scope (documented follow-ups)

- **Per-action consent** moved into the ledger (the `consent_text_initiator` flow stays flag+log for now).
- **Per-action / per-purpose guardian OTP** (the issue's literal "acting requires guardian OTP") — covered here as login-time guardian consent; a per-action variant is a later extension.
- **Granular / per-organization revocation** (depends on action-level consent).
- **Admin content-editing UI** (publish is API + seed only).
- **Removal** of the deprecated `terms_accepted` / `privacy_accepted` columns (later cleanup).

## Phasing (suggested implementation order; one spec, natural phases)

1. Data model + migration + seed; `consent_service` + status logic + `GET /consent/active` & `/status`; `POST /accept`.
2. Signup UI (DOB + checkbox + popup) + post-verify accept; `/privacy` `/terms` pages.
3. Login re-consent gate + onboarded first-login prompt; `requireConsent` preHandler; stop hardcoding booleans in `participant.ts`; backfill.
4. Minors: guardian popup + guardian OTP endpoints + guardian consent record + gating.
5. Revocation (`POST /consent/revoke`, API-only — no UI); admin publish API.

UI prototypes for the consent popups / dialogs will be produced **after** this design is approved, before implementation (per the user's request).

## Open questions (to resolve before/during implementation)

1. **Minor re-consent on a terms/privacy update — whose consent?** When a document version changes and a **returning under-18** user logs in, who must re-consent? The flow as written re-takes the **user's** consent via the normal re-consent modal and only invokes the guardian flow when `guardian_consent_required` is set for *initial* approval — so it does **not** currently re-trigger the guardian on a version bump. Options:
   - **(a) Guardian re-consents** — a version bump re-triggers the guardian flow (re-OTP the stored guardian contact to approve the new version); the guardian's versioned consent is what gates. Rationale: for an under-18 the guardian is the legal consenter, so their approval of the *old* version shouldn't carry to a *new* one.
   - **(b) Both** — the minor re-accepts (acknowledgment) **and** the guardian re-approves the new version.
   - **(c) Minor only** — the minor re-accepts; the guardian's original approval persists (simplest, but legally weak for under-18).

   This decides whether, for minors, `needs_consent`/re-consent keys off the **guardian's** versioned `consent_record` (a/b) or the **minor's** (c), and whether a version bump re-opens the guardian OTP flow. **Decision pending.**
