# End-to-End Functional Test Strategy — Signals-DPG

> **Status:** Design / strategy (not yet implemented).
> **Audience:** QA, backend, frontend, release engineering.
> **Purpose:** Define the end-to-end (E2E) functional test suite that acts as the
> **release gate** for `signals-dpg` — the check that must pass before any version
> is promoted to a release. This document is the source of truth for *what* the gate
> covers and *why*; it does not prescribe individual test-case code.

**How to read this document.** Sections 1–3 set the philosophy, scope, and the
environment/persona model. Section 4 (the journey catalog) is the core — the
release-gating scenarios. Sections 5–6 add the negative/security matrix and the
multi-instance tier. Sections 7–11 cover data, tooling, CI wiring, traceability,
and the phased rollout.

A recurring principle throughout: **the code is the source of truth.** The plans and
specs under `docs/superpowers/` are point-in-time records; where a spec and the code
disagree, the tests assert what the code does. Invariants in this document were
cross-checked against the current code (auth middleware, consent services, guardian
gates, classifier) as of authoring.

---

## 1. Purpose & release-gate philosophy

### 1.1 What "release gate" means here

The E2E functional suite is a **binary, pre-release quality gate**: it answers one
question — *"Do the real user journeys still work end to end, across the real stack,
with the real invariants intact?"* If the gate is red, the release does not ship.

It is deliberately **not** a replacement for the existing test layers. It sits on top
of them and asks a different question than they do (see §2).

### 1.2 The three gate tiers

The gate is layered so that a fast signal fails first and the expensive fidelity runs
only when the cheap checks pass.

| Tier | Name | Runs against (external target) | Blocks release? | Wall-clock target |
|---|---|---|---|---|
| **G0** | Static + unit + integration | Per-PR CI (own db+redis; not the external suite) | Yes (already exists, extended) | < 10 min |
| **G1** | API-level E2E (single instance) | Local + dev target | Yes | < 15 min |
| **G2** | Full-stack UI E2E (single instance) | Dev target (release) + local | Yes for release | < 25 min |
| **G3** | Multi-instance / network (peer instances) | Dev target (release, Phase 2) | Yes for release (Phase 2) | < 20 min |

- **G0** is today's CI (2 typechecks + `pnpm -r test` + schema-parity + bundle
  freshness), **plus** a new job that actually runs the API integration tests
  (`test:integration`), which today are excluded from CI. This is the single highest-ROI
  gap to close and is a prerequisite for everything below.
- **G1** black-boxes the running API over HTTP across full multi-endpoint journeys.
- **G2** drives the React UI in a real browser against a live API + real backing infra.
- **G3** runs against 2+ already-running signals instances configured as network peers
  (Phase 2 — see §6, §11).

### 1.3 Pass/fail criteria (what makes the gate green)

A release candidate passes the gate when **all** of the following hold:

1. **Every P0 journey passes** (100%). P0 journeys are the "money paths" — if any P0
   fails, the release is blocked with no exceptions (§4 marks priority per journey).
2. **Every security/invariant guard passes** (100%). The negative matrix in §5 —
   fail-closed U18 gates, consent server-derivation, PII non-leakage, auth boundaries.
   These are treated as P0 regardless of the journey they attach to.
3. **P1 journeys** pass at ≥ 98%; any failure is triaged and either fixed or explicitly
   waived by the release owner with a linked issue before ship.
4. **No new flake** above the flake budget (§9.4). A flaky gate that gets rubber-stamped
   is worse than no gate.
5. **Coverage traceability (§10) shows no P0 endpoint/screen/invariant unmapped.**

### 1.4 Non-goals

- **Not performance/load testing.** Latency, throughput, and cache-stampede behavior
  are out of scope here (a separate perf suite; the `benchmark` skill covers page-level
  web-vitals if wired). The gate asserts *correctness*, not *speed*.
- **Not exhaustive schema-permutation testing.** The suite covers a **representative
  network matrix** (§3.3), not every network × domain × brand combination.
- **Not a unit-test replacement.** Field-level validation, classifier math, crypto
  primitives, and copy rendering stay at the unit layer where they belong.
- **Not accessibility or visual-regression** (candidates for a follow-on; the
  `design-review` / `benchmark` skills can seed these later).

---

## 2. Scope & the test pyramid

### 2.1 Where E2E sits

```
                 ┌───────────────────────────────┐
        G2/G3    │  Full-stack UI E2E (browser)   │   few, high-value, slow
                 │  + multi-instance peer fetch   │   "does the whole app work?"
                 ├───────────────────────────────┤
        G1       │  API-level E2E (HTTP journeys) │   more, medium, stable
                 │  multi-endpoint, real DB/Redis │   "do the contracts compose?"
                 ├───────────────────────────────┤
        G0       │  Integration (Fastify inject)  │   many, per-route + DB
                 │  Unit (vitest, no DB)          │   most, fast, isolated
                 └───────────────────────────────┘
```

The existing suites are strong at the bottom two layers (59 API unit files, 18 API
integration files, 38 UI component files). **The gap is the top two layers** — there is
no browser E2E and no cross-instance E2E, and the integration layer never runs in CI.

### 2.2 The division of labor: what each layer owns

To avoid the anti-pattern of re-testing the same logic at every layer, each layer has a
clear charter:

- **Unit** owns *pure logic*: `classify_item`, `isMinor(dob)`, consent-version
  resolution, jitter math, mask formatting, bulk-envelope shaping, copy rendering.
  Fast, exhaustive on edge values. **The E2E suite does not re-derive these** — it
  trusts them and asserts the *observable* outcome.
- **Integration (Fastify `inject`)** owns *single-route contract*: status codes, error
  codes, auth preHandlers, DB side effects for one endpoint. Already well covered.
- **API-level E2E (G1)** owns *multi-endpoint journeys over real HTTP*: the composition
  of routes into a user outcome, with a real running server, real Postgres partitions,
  real Redis cache and TTL behavior. This is where "signup → consent → profile →
  discoverable → action → event → PII reveal" lives as one flow.
- **UI E2E (G2)** owns *the user actually using the product*: schema-driven form
  rendering, the OTP screens, consent modals, the guardian flow, map/list discovery,
  action modals, bulk selection, i18n/theming — driven through the browser against a
  live stack. It is the only layer that proves the UI↔API contract holds against the
  real UI code.
- **Multi-instance E2E (G3)** owns *network-aware behavior*: inter-instance peer fetch,
  peer authentication, and cross-instance PII/consent behavior between signals instances.

### 2.3 UI-layer vs API-layer split (the explicit rule)

Because you asked the gate to exercise **both** UI and API layers, the split rule is:

- **Drive through the UI (G2)** for journeys where the *UI logic itself* is the risk:
  schema-form rendering and validation, OTP/consent/guardian modal orchestration,
  discovery filters and map, action modal + PII-reveal UX, bulk selection, i18n, and
  network/brand theming. One representative happy path per journey through the browser.
- **Drive through the API (G1)** for *breadth, edge cases, and non-UI actors*: the full
  negative matrix, service-auth/on-behalf-of, admin participant tiers, consent ledger
  invariants, partition correctness, inter-instance fetch. These have no UI or are far
  cheaper and more stable to assert at the HTTP layer.

Rule of thumb: **each invariant is asserted at exactly one layer — the cheapest layer
that can still observe it.** The UI E2E happy path proves the wiring; the API E2E proves
the depth. They are complementary, not redundant.

---

## 3. Personas & test environments

### 3.1 Personas (the actors the gate must cover)

Derived from the auth model and UI persona map. Each persona is a reusable fixture in
the harness (a pre-provisioned identity + credentials/session).

| # | Persona | How it authenticates | Can do |
|---|---|---|---|
| P1 | **Anonymous visitor** | none | Browse/search/filter, view cards & map, tourist app; **cannot** act or create profiles |
| P2 | **Adult member** | session (OTP login) | Create/edit own profiles, initiate & respond to actions, bulk connect, wallet import, match scores |
| P3 | **U18 minor** | session (OTP) + guardian gate | Same as P2 **only after** a guardian `source='guardian'` consent; fail-closed until then |
| P4 | **Guardian** | OTP challenge (not a full account) | Provide DOB attestation + consent on ward's behalf; ward-count limited server-side |
| P5 | **Network-service org** | `x-api-key` + `x-acting-org-id` (type `network_service`) | Full admin: upsert aggregators, create/read/decrypt participants (served-domain scoped), on-behalf-of actions unrestricted |
| P6 | **Aggregator org** | `x-api-key` + `x-acting-org-id` (type `aggregator`) | Own participants only, dashboard/export, on-behalf-of scoped to `onboarded_by_org_id` |

Notes that the gate must encode:
- **`voice` org type** is a first-class rejection case today (participant create /
  on-behalf-of → `403 ACTING_ORG_TYPE_NOT_ALLOWED`). It is a persona-shaped *negative*.
- **Admin-domain email** (`ADMIN_DOMAINS`) is a bootstrap exemption to the self-signup
  gate — a variant of P2 used to seed data even on a `gated` instance.
- **Domain-scoped portal user**: any of P2/P3 whose profile domain is *not* in the
  instance's `SERVED_DOMAINS` — must be blocked at OTP by the domain gate ("wrong
  portal"). A cross-cutting negative applied to P2/P3.

### 3.2 Environment topology

The gate runs entirely against tooling **inside the `signals-dpg` repo** — the standalone
full-stack compose at `signals-dpg/local-setup/docker-compose.yml` (Postgres + Redis +
bootstrap + API + UI), plus the minimal `signals-dpg/docker-compose.yaml` (db + redis) for
the G1 API layer. **No parent-directory or sibling-repo compose is used** — every dependency
is signals' own or a local stub:

- **Postgres 17** (PostGIS + pgvector), partitioned item/action/event tables
- **Redis** (caching, OTP, rate-limit)
- **better-auth** over the same Postgres/Redis (OTP, sessions, API keys, org plugin) —
  note: signals auth is better-auth, not an external IdP
- **notification-service stub** — signals dispatches OTP/guardian/support messages through
  the `@dpg/notification` HTTP client; the gate points it at a local stub that records
  payloads (the email/SMS oracle — see §7.4, §7.5). Signals has no direct SMTP dependency.

**Execution model: external only.** The suite never brings up, migrates, seeds, or tears
down the stack. It always runs against an **already-running signals-dpg instance** — your
local instance or a deployed dev instance — chosen via a config file (§8.3). Standing up a
local instance is a convenience (`signals-dpg/local-setup/` compose, or `signals-dpg/SETUP.md`),
but from the suite's point of view the target is just a set of URLs + credentials it points
at. There is no CI-managed/ephemeral mode at this stage.

**Prerequisites the target instance must be launched with** (the suite *declares and checks*
these via config — it cannot set them on a running instance):
- `CREATE_TEST_OTP=true` — makes OTP codes retrievable so OTP journeys run headlessly. If the
  target lacks it (and exposes no inspectable notification sink), OTP journeys are
  **skipped-and-reported**, not silently passed (§8.3).
- `SIGNALS_PII_KEY` — when the target runs a **known** key (a local instance you control), the
  suite asserts deterministic jitter/decrypt *values*; against a dev instance whose key you
  don't hold, it asserts *masking behavior* instead of exact coordinates.
- `INSTANCE_SHARED_SECRET` — identical across the two peers for the G3 multi-instance case.
- `PEER_AUTH_MODE` — the target's mode (`permissive`/`enforced`) is declared in config so the
  G3 peer-auth expectations match the running instance.
- `SELF_SIGNUP_MODE` / `LOGIN_CHANNELS` — declared in config; the suite runs the journeys the
  target's mode enables (a `gated` target runs Journey B; an `allowed` target runs Journey A).
- `AUTH_MIDDLEWARE_ENABLED=true` — the suite never targets an instance with auth disabled.

### 3.3 The parametrization matrix (schema-driven ⇒ tests must be data-driven)

The app has **no domain-specific knowledge**; everything derives from `network.json` +
`consent.json`. The suite must therefore be parametrized, not hardcoded to one network.
The gate uses a **representative matrix** rather than the full cross-product:

| Network | Domains served | Chosen because it exercises… |
|---|---|---|
| `blue_dot` | `seeker`, `provider` | The canonical two-sided flow; `connect` action; the default local stack |
| `purple_dot` | `seeker`, `provider` | The **deterministic dashboard-count fixture** (`scripts/e2e/`) + service-onboarded participants (`onboarded_via` link/bulk) |
| `yellow_dot` | `student`, `individual_tutor_...` | **Guardian-consent-required domain** — the U18 fail-closed path |
| `orange_dot` | `practitioner` | **Edge: a network with no actions** — must produce only terms/privacy/profile_creation, never action rows; tourist app default |
| `inter-network-action` | (cross) | Inter-network action example — G3 |

Each journey in §4 states which matrix cells it must run against. Brand overlay
(white-label, e.g. `upsdm` on `blue_dot`) and served-binding host-routing are asserted
by a **dedicated theming/binding journey** rather than multiplied across every journey.

### 3.4 What the harness parametrizes per run

Because the UI resolves config at runtime (`window.__DPG_UI_CONFIG__` / `/config.js` /
query params) and the API resolves network/domains from env, E2E tests set, per case:
network id, served domains, brand, served-binding host, API base URL, language, and the
signup/login mode — via config injection, **never** by editing built artifacts.

---

## 4. Journey catalog (the release-gating scenarios)

Each journey below is described at **scenario level**: preconditions, the flow, the key
assertions/oracles, the invariants it guards, and the layer(s) and matrix cells it runs
against. Priority (P0/P1/P2) drives the gate rules in §1.3. "Layer" is G1 (API), G2 (UI),
or both. Negative variants are catalogued separately in §5 and cross-referenced.

Legend: **Oracle** = the observable signal a test checks (HTTP body/status, DB row,
notification-stub record, UI element, cache behavior).

---

### Journey A — Adult self-signup → schema-typed profile → discoverable — **P0**

**Persona:** P2 · **Layer:** both · **Matrix:** `blue_dot/seeker`, `orange_dot/practitioner` (no-action edge)

**Precondition:** instance with `SELF_SIGNUP_MODE=allowed`, `CREATE_TEST_OTP=true`.

**Flow:** anonymous visitor → login page picks phone or email channel (channels come
from `GET /auth/config`) → `check-user` reports new → provides name + domain (options
from the served network schema) → OTP requested → OTP retrieved (test OTP / notification stub) →
verified (user created, `onboardedByOrgId=null`, session issued) → accepts terms +
privacy (`POST /consent/accept`) → creates a schema-driven profile
(`POST /item/create`, optional inline `profile_creation` consent) → classifier assigns
`draft` or `live`.

**Key assertions / oracles:**
- After OTP verify: a real session exists; `GET /auth/config` values match server env
  (UI must gate on server value, never a client default).
- Profile created with **backend-generated** `item_instance_url` / `item_schema_url`;
  any client-supplied values for these (or `lifecycle_status` / `completion_pct`) are
  **ignored** — assert the stored row used server values.
- Profile is discoverable in `GET /network/item/fetch` **only** once required fields are
  complete **and** `profile_creation` consent is accepted → status `live`. Before
  consent, it is `draft` and absent from discovery.
- `completion_pct` reflects required-only fields.
- (UI) The schema-driven form renders the correct fields for the chosen domain; a
  single-role user skips the role picker.

**Invariants guarded:** consent gates discoverability · backend-generated URLs ·
`item_type` from schema not freeform · completion = required-only · classifier is the
only go-live path.

---

### Journey B — Gated instance blocks public self-signup — **P0**

**Persona:** P2 (blocked) + P5 (provisions instead) · **Layer:** both · **Matrix:** `blue_dot`

**Precondition:** `SELF_SIGNUP_MODE=gated` (the **default**).

**Flow & assertions:**
- Anonymous → `check-user` for an unknown identifier reports `userExists:false`; UI shows
  "contact your aggregator" and **sends no OTP**.
- Direct API abuse: `requestOtp` early-exits (no OTP pump); `verifyOtp` returns
  `403 SELF_SIGNUP_DISABLED` **before** any user/session is created — assert no user row,
  no session.
- **Exemption:** an `ADMIN_DOMAINS` email is allowed through (bootstrap path).
- The correct provisioning path works: P5 (`network_service`) creates the participant via
  `POST /admin/participant`; that user can then log in.

**Invariants guarded:** self-signup gate is server-enforced and fail-closed · admin-domain
exemption · gating does not leak OTPs.

---

### Journey C — U18 minor signup + guardian consent (fail-closed) — **P0**

**Persona:** P3 + P4 · **Layer:** both · **Matrix:** `yellow_dot/student` (guardian_consent_required domain)

This is the highest-risk journey (regression #311 territory). Fail-closed behavior is
tested as hard as the happy path.

**Flow (happy path):** `POST /auth/u18-precheck` hints `requiresDob` for a gated domain →
pre-auth signup guardian: `POST /consent/u18/signup/guardian` + `/verify` (guardian OTP
**before** the minor's account is created) → minor completes OTP → DOB captured
(`u18/dob`) → guardian OTP for account terms/privacy (`u18/guardian` + `/verify`) →
profile created → guardian profile-consent OTP (`u18/profile-consent/*`) promotes the
profile to `live`.

**Key assertions / oracles:**
- The minor's profile reaches `live` **only** via a guardian `source='guardian'`
  `profile_creation` row — **never** the ward's own self-consent. Assert the promoting
  consent row's `source`.
- **Fail-closed variants (all P0):**
  - Null `date_of_birth` on a gated domain is **not** treated as adult → profile stays
    `draft`, action blocked.
  - Minor with no guardian row stays `draft`; self-accepting profile consent does **not**
    promote.
  - `guardianGateBlocksGoLive` fires on **both** promotion paths (create/consent-accept
    **and** item-update) — assert an edit that would go live is still blocked.
- **Action-level guardian gate:** minor performing/accepting `connect`/`apply` triggers a
  scoped guardian OTP (`GUARDIAN_OTP_REQUIRED`), scoped to
  `(wardUserId, actionType, sourceItemId, targetItemId)`, valid ~10 min. Wrong/late code →
  `GUARDIAN_OTP_INVALID` / `GUARDIAN_OTP_THROTTLED` / `_RATE_LIMITED`.
- Adult on the same domain, or any user on a non-gated domain → guardian gate
  `not_required` (no OTP, never blocked) — assert the gate does **not** over-fire.
- (Oracle) guardian OTP email rendered and captured via the notification stub; SMS code
  path asserted via test OTP.

**Invariants guarded:** guardian gate is the single source of truth, fail-closed on null
DOB / missing guardian, on every promotion path · age recomputed per read, never stored ·
OTP scope binding · gate does not over-fire for adults/non-gated domains.

---

### Journey D — Item performs an action on another → event — **P0**

**Persona:** P2 (both sides) · **Layer:** both · **Matrix:** `blue_dot` (`connect`), `purple_dot` (`apply`)

**Flow:** initiator opens action modal → consent checkbox → `POST /action/perform`
(**single JSON object** — Raya/voice compat) → `item_actions` row + event created →
receiver `POST /action/update-status` (accept) → status event.

**Key assertions / oracles:**
- `/action/perform` accepts a **single object** and returns the `{results, summary}`
  envelope with `summary.total === 1`. The array/batch path is **only** on
  `/action/perform/bulk` — assert an array to `/perform` is rejected, not silently
  handled.
- **Both source and target must be `live`** at perform time → otherwise
  `409 PROFILE_NOT_LIVE`. Accept re-checks both still live (race guard).
- Action-consent gate: when the interaction declares `consent_text_initiator` (or receiver
  text + target status ∈ `reveals_pii_on_status`), a missing `consent` block →
  `403 CONSENT_REQUIRED`. The consent text snapshot + server-stamped `consented_at` are
  written to the event payload **verbatim** (not re-resolved from current config later).
- Consent copy is sourced from `consent.json` (not deprecated `network_workflow` fields).
- (UI) The action modal renders the requirement/event schema form; status pills reflect
  new → pending → accepted/rejected/completed/cancelled.

**Invariants guarded:** single-object perform contract · live-on-both-ends · action-consent
snapshot immutability · consent copy source of truth.

---

### Journey E — Bulk actions (partial-failure semantics) — **P1**

**Persona:** P2 · **Layer:** both · **Matrix:** `blue_dot`

**Flow:** home "connect all" selection → `POST /action/perform/bulk`; and My-Actions bulk
status → `POST /action/update-status` (bulk dialog).

**Key assertions / oracles:**
- Status-code contract: `201` all-ok · `207` partial · `422` all-fail · `400`
  `BULK_EMPTY_ARRAY` / `BULK_LIMIT_EXCEEDED` (over `bulk_max_items`).
- The `{results, summary}` envelope maps per-item outcomes; a mix of live/not-live targets
  yields a `207` with the exact failing indices (`bulkFailureIndices` on the UI side).
- (UI) The bulk action bar reflects per-item success/failure; no all-or-nothing rollback.

**Invariants guarded:** bulk envelope shape · per-item partial failure · limit enforcement.

---

### Journey F — PII reveal on accepted action — **P0**

**Persona:** P2 (both sides) · **Layer:** both · **Matrix:** `blue_dot`

**Flow:** after an action reaches a status in the interaction's `reveals_pii_on_status`,
a participant calls `GET /action/:action_id/contact-details` and sees the **other** actor's
merged (decrypted) item.

**Key assertions / oracles:**
- Reveal succeeds **only** when caller is a participant **and** current `action_status ∈
  reveals_pii_on_status` (the status set is validated against `event_schema.status.enum`
  at boot — never hardcoded `'accepted'`).
- **Error matrix (all P0):** `401 UNAUTHORIZED` · `404 ACTION_NOT_FOUND` ·
  `403 NOT_ACTION_PARTICIPANT` · `403 PII_NOT_REVEALED` (status not in reveal set) ·
  `404 OTHER_ITEM_NOT_FOUND` · `501 CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` (other actor on a
  different instance — G3).
- Response carries `Cache-Control: no-store`; every 2xx appends a `pii_reveal_audit` row;
  an audit-insert failure does **not** block the 200.
- **Recomputed every read:** if the action leaves `live`/reveal status, a subsequent call
  re-hides (`403`); returning to reveal status reveals again **with no re-consent**.
- (UI) The contact-details modal shows real values only after accept; the consent checkbox
  gates the reveal per `reveals_pii_on_status`.

**Invariants guarded:** reveal is participant + status gated · reveal set is config-driven ·
audit on every reveal · non-blocking audit · access recomputed per read · cross-instance
refusal.

---

### Journey G — PII encryption at rest, masking & location jitter — **P0**

**Persona:** P2 (self) + P1/P2 (stranger view) · **Layer:** G1 (+ UI spot-check) · **Matrix:** `blue_dot`

**Flow & assertions:**
- `item_private_state` is stored encrypted (`v1:` prefix, AES-256-GCM). `item_state` always
  holds every field: real public values + **type-aware masks** for private
  (`a***@x.com`, `+91-XX-XXXX-X123`, `XXXX-XX-XX`). Assert directly against the DB row that
  raw PII is never in `item_state` and `item_private_state` is ciphertext.
- **Read-path matrix:**
  - Self read (`/item/fetch`, `includePrivateState=true`) → real values.
  - Post-accept reveal (Journey F) → real values merged.
  - Stranger / inter-instance (`/network/item/fetch`) → masked as stored.
  - `item_private_state` never appears in **any** response body.
- **Cache-key correctness:** the fetch cache key **includes** `includePrivateState` — a
  stranger request must never hit a self-decrypted cache entry. This is a P0 negative:
  self-read then stranger-read for the same item must not leak.
- **Location jitter:** private coordinates are offset to a deterministic keyed point in the
  configured annulus (default 100–250 m). Re-saving the same item does **not** move the pin
  (deterministic seed); repeated public snapshots return the identical jittered point
  (can't be averaged back to true location).
- Tamper/`v1:`-prefix rejection and `DECRYPT_FAILED` on corruption are asserted at the unit
  layer; the E2E layer asserts the **observable** masking and cache isolation.

**Invariants guarded:** PII encrypted at rest · masks always present · private state never
serialized · cache key includes reveal scope · jitter deterministic & non-averageable.

---

### Journey H — Discovery / search (instance-local vs network) — **P0**

**Persona:** P1 + P2 · **Layer:** both · **Matrix:** `blue_dot`, `purple_dot`

**Flow & assertions:**
- **Instance-local** `GET /item/fetch` — owner-scoped, ~1s Redis TTL. Assert the cache TTL
  behavior (second read within TTL served from cache; invalidation on item write via
  `invalidateItemFetchCache`).
- **Network** `GET /network/item/fetch` — returns `live` items only; count-first discovery
  then merged results. **Only complete aggregates (all peers responded) are cached** —
  assert a partial result (a peer down, G3) is **not** cached.
- Filters: domain tabs, enum filters, search query, map vs list — URL-param driven; assert
  a filtered query returns the expected subset and empty-state renders when none.
- (UI) Map view renders markers with correct clustering; list view matches; anonymous P1
  can browse but the match-score/action buttons prompt sign-in.
- Item create/update/delete emits a best-effort Redis `XADD` to `signals:item-events`; a
  Redis outage must **not** break the write (assert write succeeds with Redis stopped).

**Invariants guarded:** two distinct fetch paths · live-only network results · complete-
aggregate-only caching · search-event emission is best-effort/non-blocking.

---

### Journey I — Integrating-DPG two-header service auth & participant tiers — **P0**

**Persona:** P5, P6 (+ `voice` negative) · **Layer:** G1 · **Matrix:** `blue_dot`, `purple_dot`

**Flow & assertions** (`/api/v1/admin/*`, two headers `x-api-key` + `x-acting-org-id`):
- **Auth precedence:** apikey checked first; an invalid key → `403 INVALID_API_KEY` with
  **no** session fallback. Missing acting-org → `400 MISSING_ACTING_ORG`; unauthenticated →
  `401`; unknown org → `404 ACTING_ORG_NOT_FOUND`; wrong type → `403
  ACTING_ORG_TYPE_NOT_ALLOWED`; unregistered service user → `403 SERVICE_USER_NOT_REGISTERED`.
- **Aggregator upsert** (`POST /admin/aggregator/upsert`) — only `network_service`
  (`403 NOT_NETWORK_SERVICE` otherwise); idempotent on `slug`.
- **Participant tier matrix** (`POST/GET /admin/participant`, `/participant/decrypt`):
  - `network_service` = full admin, served-domain scoped; `item_state` optional →
    account-only vs classified draft/live.
  - `aggregator` = own users only; cross-aggregator read → `owned_elsewhere:true, items:[]`.
  - `voice` = rejected today (`403 ACTING_ORG_TYPE_NOT_ALLOWED`).
  - Errors: `409 USER_ALREADY_EXISTS`, `ITEM_NOT_OWNED_BY_USER`.
- **Participant decrypt** ownership-keyed on the creator's `onboarded_by_org_id`.
- **On-behalf-of actions** (`/action/perform` with `acting_as_user_id`): `aggregator`
  scoped to `onboarded_by_org_id === acting_org.org_id`; `network_service` unrestricted.
  Matrix negatives: `400 CANNOT_OVERRIDE_SELF`, `400 MISSING_ACTING_AS_USER_ID`,
  `404 USER_NOT_FOUND`, `403 NOT_AUTHORIZED_FOR_TARGET`, `403 SOURCE_ITEM_NOT_OWNED_BY_ACTOR`.
  Audit columns `performed_by_org_id` / `performed_by_service_user_id` populated at create.
- **`/action/update-status` is self-acted only** — `acting_as_user_id` rejected by Zod;
  caller must own the target (`403 NOT_TARGET_ITEM_OWNER`).

**Invariants guarded:** apikey-priority no-fallback · acting-org check order · tier
capability matrix · on-behalf ownership scoping · update-status self-only.

---

### Journey J — Aggregator dashboard & metrics recompute — **P1**

**Persona:** P6 · **Layer:** G1 · **Matrix:** `purple_dot` (deterministic dashboard fixture)

**Flow & assertions:** `GET /aggregator/dashboard` (+ `/export` CSV), per-`(aggregator,
domain)` rollup from `item_metrics` cache (TTL 3600s).
- Seed the **deterministic purple_dot fixture** (`scripts/e2e/`) and assert the exact
  expected rollups (e.g. `by_status = {new:2, active:3, at_risk:3, inactive:2}`). This
  journey has a ready-made oracle — use it verbatim.
- `?refresh=true` → blocking advisory-lock recompute; normal read uses `try_advisory_lock`
  (serve stale, no pileup). `metadata.refreshed` reflects whether a recompute ran.
- `by_status` from config `status_rules` (first-match-wins, ends with `default`);
  `by_action_status` canonical buckets from `metric_categories` (unknown key = boot error
  `NETWORK_CONFIG_INVALID`; `null` = not tracked).
- `/export` returns well-formed CSV matching the dashboard numbers.

**Invariants guarded:** config-driven status/action buckets · advisory-lock recompute
directionality · cache TTL & `refreshed` flag · CSV/JSON parity.

---

### Journey K — Consent ledger invariants — **P0**

**Persona:** P2 · **Layer:** G1 · **Matrix:** `blue_dot`, `orange_dot` (no-action edge)

**Flow & assertions** (append-only ledger, server-derived versions):
- **Version derived server-side.** A client-supplied `version` is never trusted — assert a
  stale/forged version is resolved to the server's current version.
- **Append-only; latest per `(subject, type)` wins by `seq`**, not timestamp. `needs_consent`
  = no accepted row equal to `current_version` — correct on both forward-bump **and**
  rollback (assert both).
- `terms` / `privacy` / `profile_creation` are the only universal categories; action
  categories are per-network. **`orange_dot` (no actions) produces zero action consent
  rows** — assert the ledger never invents a `connect`/`apply` row there.
- `profile_creation` is idempotent via the partial unique index (re-accept is a no-op).
- Re-consent applies to terms/privacy only; profile/connect/apply consent is asked **every
  time** (assert a second action re-prompts consent).
- `consent.json` copy: `__SUPPORT_EMAIL__` placeholder rendered to `CONSENT_SUPPORT_EMAIL`
  (distinct from `SUPPORT_EMAIL`).

**Invariants guarded:** server-derived versions · append-only/seq-ordered · rollback
correctness · per-network category derivation · idempotent profile consent · re-consent
policy.

---

### Journey L — UI cross-cutting: theming, i18n, served-binding, support — **P1**

**Persona:** P1/P2 · **Layer:** G2 · **Matrix:** `blue_dot` + `upsdm` brand; `orange_dot` tourist

**Flow & assertions:** these are UI-mechanism journeys, asserted once rather than multiplied
across every functional journey.
- **Network theming:** `blue_dot` base palette vs `upsdm` white-label overlay resolve
  correctly; light/dark toggle works.
- **Served-binding host routing:** a given `Host` selects the right `VITE_SERVED_BINDINGS`
  via `/config.js` (`Cache-Control: no-store`); an unknown host falls back to serve-all;
  a user with a profile in an unserved domain is blocked at OTP ("wrong portal").
- **i18n:** language switcher toggles `en`/`hi` (and `kn` when enabled); UI chrome is
  localized, schema content is not.
- **Tourist app:** login-free read-only map + nearest-first list; Call/Website/Directions
  actions work; `orange_dot` default.
- **Support:** `POST /support` dispatches an email via the notification client
  (notification-stub oracle); `503 SUPPORT_NOT_CONFIGURED` when `SUPPORT_EMAIL` unset.

**Invariants guarded:** runtime config precedence (query → `__DPG_UI_CONFIG__` → `VITE_*`
→ default) · host-routed binding · localization scope · tourist read-only surface.

---

### Journey M — Wallet / credential import — **P2**

**Persona:** P2 · **Layer:** G2 (mocked provider) · **Matrix:** `blue_dot`

**Flow & assertions:** wallet import modal → Dhiway verified-credentials or DigiLocker
provider → imported VC fields map into the schema form (`import-mapping`). Providers are
gated by env (`isWalletConfigured` / `isDigiLockerConfigured`) — when unconfigured the entry
point is hidden. Because these hit external providers, the gate uses a **stubbed provider**
(contract-level) rather than a live third-party call.

**Invariants guarded:** VC→form field mapping · provider gating by config · graceful
absence when unconfigured.

---

### Journey N — Multi-instance / network-aware tier (Phase 2) — **P0 (Phase 2)**

**Persona:** P2 across instances + peer instances · **Layer:** G3 · **Matrix:** two `blue_dot`
instances (+ `inter-network-action`)

Covered in detail in §6. Summary of the release-gating scenarios:
- Inter-instance `GET /network/item/fetch` fans out to peers via `count_local` /
  `fetch_local`; a peer being down yields a **partial, uncached** result.
- Peer auth: `permissive` allows a missing token but rejects a present-but-invalid one
  (`401 PEER_AUTH_FAILED`); `enforced` requires a valid HMAC token bound to path+body.
- Cross-instance PII reveal → `501 CROSS_INSTANCE_REVEAL_NOT_SUPPORTED`.
- Cross-instance action consent gate fires **only** at the entry instance; peer mirror
  endpoints propagate the persisted consent snapshot and do **not** re-gate.

---

## 5. Negative, edge & security matrix

These are **all treated as P0** per §1.3(2) — a failure here blocks the release regardless
of which journey it attaches to. Many are the fail-closed / boundary cases already named
inline in §4; this section consolidates them into a single guard list so nothing is
mapped to "the happy path passed, so we're fine."

### 5.1 Authentication & authorization boundaries

| Guard | Expected |
|---|---|
| Invalid `x-api-key` | `403 INVALID_API_KEY`, **no** session fallback |
| Missing acting-org on `/admin/*`, `/aggregator/*` | `400 MISSING_ACTING_ORG` |
| Acting-org check order | unauth `401` → not-found `404` → wrong-type `403` → unregistered `403` (order matters) |
| Wrong org type for capability | `403 ACTING_ORG_TYPE_NOT_ALLOWED` / `403 NOT_NETWORK_SERVICE` |
| `voice` org attempts participant/action | rejected today (`403`) |
| Route without `preHandler` (item/consent groups) | is **unauthenticated by design** — assert the intended public/auth’d posture per route, since there is no inherited default |
| Auth kill-switch | gate always runs `AUTH_MIDDLEWARE_ENABLED=true`; never green with auth off |
| Rate limits | `/api/auth/*` (10 req/10s) and `u18-precheck` per-IP throttle return the throttle response, not a 500 |

**Fail-open is a release blocker.** Any auth guard that *passes* when it should *deny* is a
P0 stop-ship, even if every happy path is green.

### 5.2 Consent & U18 fail-closed guards

| Guard | Expected |
|---|---|
| Client-supplied consent `version` | ignored; server-derived version used |
| Null DOB on gated domain | **not** adult; profile stays `draft`, action blocked |
| Minor self-accepts profile consent | does **not** promote; only `source='guardian'` row promotes |
| Guardian gate on item-**update** path | also blocks go-live (both promotion paths gated) |
| Guardian gate for adult / non-gated domain | `not_required` — must **not** over-fire |
| Guardian action OTP: wrong / expired / replayed | `GUARDIAN_OTP_INVALID` / `_THROTTLED` / `_RATE_LIMITED`; scope-bound to the exact action tuple |
| Ward-count limit | server rejects an over-limit guardian |
| Rollback of consent version | `needs_consent` recomputes correctly (not stuck accepted) |
| `orange_dot` (no actions) | zero action-consent rows ever created |

### 5.3 PII non-leakage guards

| Guard | Expected |
|---|---|
| `item_private_state` in any response | never present |
| Raw PII in `item_state` | never; masks only for private fields |
| Cache key omitting `includePrivateState` | **must not** happen — stranger read after self read returns masked, not decrypted |
| Cross-instance reveal | `501 CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` |
| Reveal when status not in reveal set | `403 PII_NOT_REVEALED` |
| Reveal by non-participant | `403 NOT_ACTION_PARTICIPANT` |
| Access after leaving reveal status | re-hidden (`403`); re-entering reveals with no re-consent |
| Location pin | jittered to annulus; deterministic (no drift on re-save; not averageable) |
| Corrupted ciphertext / bad `v1:` prefix | `DECRYPT_FAILED`; self-read hard-fails (no silent mask fallback) |

### 5.4 Contract & data-integrity guards

| Guard | Expected |
|---|---|
| Client sets `item_instance_url` / `item_schema_url` / `lifecycle_status` / `completion_pct` | ignored; server values win |
| Array body to `/action/perform` | rejected (single-object only); batch → `/perform/bulk` |
| Bulk over limit / empty | `400 BULK_LIMIT_EXCEEDED` / `BULK_EMPTY_ARRAY` |
| Action with a non-live source or target | `409 PROFILE_NOT_LIVE` |
| `update-status` with `acting_as_user_id` | rejected by Zod |
| `update-status` by non-owner of target | `403 NOT_TARGET_ITEM_OWNER` |
| Missing action consent when required | `403 CONSENT_REQUIRED` |
| PG unique / FK violations | mapped to explicit `23505` / `23503` handling, never a raw 500 |
| Partition pruning | item queries filter `item_network` + `item_domain`/`action_type` (assert correct results across ≥2 domains, no cross-domain bleed) |

### 5.5 Resilience / degradation guards

| Guard | Expected |
|---|---|
| Redis down during item write | write succeeds; `XADD` to `signals:item-events` is best-effort |
| Redis down during fetch | falls back to DB (no cache), still returns correct data |
| Notification service unreachable | action/consent flow still completes; notification failure is non-blocking |
| `pii_reveal_audit` insert fails | reveal still returns 200 |
| Peer instance down (G3) | network fetch returns partial, **uncached** result |
| Support email unconfigured | `503 SUPPORT_NOT_CONFIGURED`, not a 500 |

---

## 6. Multi-instance / network-aware tier (G3, Phase 2)

**Recommendation (answering the "you recommend" scope question):** ship the gate in two
phases. **Phase 1** (G0–G2, single instance) covers ~90% of release risk and is the
must-have. **Phase 2** adds G3 — the network-aware behavior that is genuinely part of this
product's identity ("network-aware backend") and has real, invariant-dense surface that a
single-instance gate cannot exercise. Do not skip it permanently; sequence it second
because standing up a reliable multi-instance topology is the hardest part of the harness.

### 6.1 Topology

Two **already-running** signals instances of the **same network** (`blue_dot`), each serving a
domain subset, sharing an **identical `INSTANCE_SHARED_SECRET`**, pointed at each other as
peers — the suite is given both via config (`apiBaseUrl` + `peer.apiBaseUrl`) and does not
launch them. A third instance or the `inter-network-action` example covers the cross-network
case. (Signals' service-auth surface — the endpoints an integrating DPG calls — is exercised at
G1 in Journey I by simulating a service caller with an API key; it does **not** require standing
up any sibling application.)

### 6.2 Scenarios (all P0 for the Phase-2 gate)

1. **Inter-instance discovery.** `GET /network/item/fetch` on instance A fans out to B via
   `count_local` → `fetch_local`, merges, returns `live`-only. Assert results include B's
   items; assert **complete aggregates are cached** and a **partial result (B down) is not**.
2. **Peer auth modes.** In `permissive`: a missing peer token is allowed, a present-but-
   invalid token → `401 PEER_AUTH_FAILED`. In `enforced`: a missing token is rejected; a
   valid HMAC token **bound to path + body** is required (assert a token replayed on a
   different path/body fails).
3. **Cross-instance PII refusal.** A reveal where the other actor lives on instance B →
   `501 CROSS_INSTANCE_REVEAL_NOT_SUPPORTED` (peers don't share keys; B's items are masked
   and indistinguishable from genuinely public).
4. **Cross-instance action + consent snapshot.** An action initiated on A against a B item:
   consent is gated **only** at A (entry); `POST /network/action/perform` (peer mirror) and
   the event mirror propagate the persisted snapshot and do **not** re-gate. Assert consent
   is not double-counted and a peer cannot fabricate consent.

### 6.3 Why this can't be faked at G1

Peer HMAC binding, complete-aggregate caching, and cross-instance PII refusal are only
observable when a *second real instance* exists with its own key material. Mocking the peer
would test the mock, not the invariant — so G3 uses real instances.

---

## 7. Test data & fixtures strategy

The suite lives or dies on **deterministic, isolated, self-cleaning data**. Because item
tables are partitioned and schema-driven, ad-hoc data is both fragile and slow to reason
about. The strategy:

### 7.1 Deterministic, schema-valid fixtures

- **Reuse what exists.** `apps/api/src/routes/v1/__tests__/integration_helpers.ts` already
  provides `generateMinimalItemState()` (schema-driven minimal item), `resolveBindings()`
  (reads `SERVED_DOMAINS` + network config at runtime so tests aren't hardcoded to a
  network), `resolveInteractionConsent()`, `consentAck()`. The E2E harness builds on these,
  not a parallel fixture system.
- **Seeded generation.** `scripts/e2e/` already generates deterministic (mulberry32-seeded)
  schema-valid fixtures — `purple_dot_qr_payloads.json`, `purple_dot_providers.csv`,
  `seed_actions.mts` with backdated timestamps. The dashboard journey (§4 J) consumes these
  directly, giving **exact expected oracles** rather than fuzzy assertions.
- **Schemas are fixtures-of-record.** `examples/schemas/{blue_dot,purple_dot,yellow_dot,
  orange_dot,inter-network-action}/` (each `network.json` + `consent.json`) are the canonical
  network definitions the gate parametrizes over — no test invents its own schema.

### 7.2 Isolation & cleanup

- **`user.tags.is_test = true`** marks every identity (and its items) the suite creates —
  this is the built-in bulk-cleanup hook. Teardown deletes by this tag, so a crashed run
  never poisons the next.
- **Per-suite ownership.** Each suite owns and cleans its own rows (the existing integration
  convention: e.g. `consent_record` deletes by `userId` in `afterEach`). No global schema
  reset between tests — the DB schema is applied once at environment bring-up.
- **Namespaced identifiers.** Test phone/email identifiers are generated per run (unique
  prefix) so parallel runs and reruns don't collide on unique indexes.

### 7.3 Target readiness (the suite never brings up schema)

In external mode the target instance is **already migrated and running** — the suite never
applies schema, migrates, or seeds it. Instead:
- **Preflight health check.** Before any test, the suite calls the target's health/readiness
  and a lightweight schema-sanity probe (a known read endpoint), failing fast with a clear
  message if the target is down or on an incompatible schema — rather than surfacing confusing
  mid-journey failures.
- **Whoever operates the target owns migrations.** Local: you ran `db:push` + `db:init` (or
  `db:migrate:deploy`) when you started the instance. Dev: the deployment's own migrate step
  did. The suite only *consumes* a ready instance.

### 7.4 OTP & email oracles

- `CREATE_TEST_OTP=true` exposes OTP codes to the harness for the OTP journeys (signup,
  login, guardian, profile-consent). This is the primary oracle.
- The **notification-service stub** is the secondary/independent oracle: signals renders
  every message (login OTP, guardian OTP email, support email) and dispatches it through the
  `@dpg/notification` HTTP client. The stub captures the delivered payload, proving the
  render+dispatch path — not just the code generation. Signals has no SMTP sink of its own.

### 7.5 External seams (how the target is wired, not injected by the suite)

External dependencies are configured **at the target instance** — external mode cannot repoint
a running instance's clients. How each target is expected to be wired:
- **Notification service** (HTTP client): a **local instance** points it at a recording stub,
  so the suite reads the dispatched payload (the §7.4 oracle) and can exercise the
  non-blocking-failure guard (§5.5). A **dev target** that routes to a real/non-inspectable
  notification service cannot serve this oracle — those dispatch-assertion and fault-injection
  tests are **skipped-and-reported** there (they still rely on `CREATE_TEST_OTP` for the code).
- **Wallet / DigiLocker / Dhiway providers**: the target is expected to run with these
  stubbed/disabled (§4 M); where a provider is genuinely configured, the import test skips.
- **Geocoding (Google / Photon)**: a local target uses a fixtured geocoder for deterministic
  jitter; a dev target uses whatever it is configured with (masking behavior still asserted).
- **Match-score provider**: asserted behaviorally; the reasoning text is not asserted verbatim.

### 7.6 Service users & keys

The `network_service` service key (P5) is **supplied to the suite via config**
(`auth.serviceApiKey` + `auth.actingOrgId`) — never seeded by the suite:
- **Local target:** run `db:seed:services` once when you start the instance to mint the org +
  apikey, then put the key into your local config file.
- **Dev target:** the deployment already has a service user; an operator provides its key via
  the config file (or a secret reference in the pipeline).

Aggregator orgs (P6) are still created **within** the service-auth journey via
`admin/aggregator/upsert`, exercising the real provisioning path rather than a seeded shortcut.

---

## 8. Tooling recommendation

### 8.1 UI E2E — **Playwright**

**Recommendation: Playwright** for the G2 browser layer.

Rationale:
- Greenfield choice (no incumbent e2e tool to honor) — so pick on merit.
- First-class **network interception** (stub the notification/wallet/geocoding seams from
  the browser side), **multiple contexts** (two users in one test — initiator + receiver for
  the action/PII journeys), and **request assertions** (verify the exact API calls the UI
  makes).
- Robust auto-waiting and trace/video artifacts on failure — essential for a gate that must
  not be flaky and must be debuggable from CI logs alone.
- Runs the app via `window.__DPG_UI_CONFIG__` / `/config.js` injection cleanly, matching the
  UI's runtime-config model — tests parametrize network/brand/served-binding/API-URL without
  rebuilding the image.
- Strong CI story (sharding, retries-with-trace, HTML report) that maps directly onto the
  gate reporting in §9.

Cypress is the main alternative; it's rejected here mainly for weaker multi-tab/multi-context
support (the two-actor journeys are awkward) and browser breadth. Playwright's multi-context
model fits this product's two-sided (seeker/provider, initiator/receiver, minor/guardian)
journeys directly.

### 8.2 API-level E2E — extend Vitest, black-box over HTTP

**Recommendation: keep Vitest** (already the repo standard) for G1, but write these as
**black-box HTTP journeys against a running server**, not `app.inject()`.

Rationale:
- One test runner across the repo lowers maintenance; reuse the existing
  `integration_helpers.ts`, env setup, and fixture generators.
- Unlike the current integration tests (which `inject` into an in-process app), G1 hits a
  **real listening server + real Redis + real partitioned Postgres** over the network — so it
  exercises the true HTTP stack, serialization, and cache/TTL behavior. A thin typed HTTP
  client (fetch wrapper) plus the shared fixtures is enough; no Supertest needed.
- G1 journeys are multi-endpoint compositions (signup→consent→profile→action→reveal) that the
  per-route integration tests deliberately don't cover.

### 8.3 Execution model & configuration (external mode)

The suite runs **only in external mode**: it targets an already-running instance selected by a
config file — it never brings up or tears down infrastructure. One config per environment,
chosen via `E2E_ENV=<name>` (or `--config <path>`). Both Playwright (UI) and the Vitest HTTP
client read the same file, so "which instance am I hitting and what may I assert here" has a
single source of truth.

**Config file shape** (`config/e2e/<env>.json`):

```jsonc
{
  "apiBaseUrl": "http://localhost:2742",   // the running signals-dpg API
  "uiBaseUrl":  "http://localhost:5173",   // the running signals-dpg UI

  "network": "blue_dot",
  "servedDomains": ["blue_dot/seeker", "blue_dot/provider"],
  "brand": null,                            // e.g. "upsdm" for white-label
  "servedBindingHost": null,                // Host header for host-routed binding
  "language": "en",

  // what the target was launched with — declared, not set by the suite:
  "selfSignupMode": "gated",                // "gated" | "allowed"
  "loginChannels": ["phone", "email"],
  "peerAuthMode": "permissive",             // "permissive" | "enforced"

  // credentials injected, never seeded by the suite:
  "auth": { "serviceApiKey": "…", "actingOrgId": "…" },

  // oracles & optional capabilities (presence gates capability-tagged tests):
  "otp": { "mode": "test-otp" },            // "test-otp" | "notification-stub"
  "notificationStubUrl": null,              // set ⇒ dispatch-assertion + fault tests run
  "db": { "url": null },                    // set ⇒ @needs-db introspection tier runs
  "deterministicPiiKey": false,             // true ⇒ exact-jitter assertions run

  // G3 only — the second already-running peer instance:
  "peer": { "apiBaseUrl": null }
}
```

**Capability-gated tests (skip-and-report, never silent-pass).** Each test is tagged with what
it needs; the runner enables or skips it from the config so every run is honest about what it
actually covered:

| Tag | Requires | Local (you control the instance) | Dev (shared) |
|---|---|---|---|
| `@needs-test-otp` | OTP retrieval (`CREATE_TEST_OTP`) | ✅ | ✅ if dev enables it, else skip |
| `@needs-notification-stub` | inspectable notification sink | ✅ | skip if dev uses a real sink |
| `@needs-db` | `db.url` in config | ✅ | usually skip (no DB access) |
| `@needs-fault-injection` | ability to stop Redis / break a seam | ✅ | skip |
| `@deterministic-key` | known `SIGNALS_PII_KEY` | ✅ | skip (assert masking instead) |

Everything **not** tagged — the bulk of the journey and negative matrix over HTTP and the
browser — runs against **either** target.

**Running it:**

```bash
# against your local instance (full fidelity — DB, stubs, fault injection available)
E2E_ENV=local pnpm e2e            # or: pnpm e2e --config config/e2e/local.json

# against the deployed dev instance (black-box subset; infra-dependent tests skip-and-report)
E2E_ENV=dev   pnpm e2e
```

A local instance is easiest to stand up via `signals-dpg/local-setup/` or `signals-dpg/SETUP.md`,
but the suite has no opinion on *how* the target got there — it only reads the config and hits
it. Secrets (service key, db url) come from the environment / a secret store, not committed JSON.

### 8.4 What we deliberately do **not** add

- No BDD/Gherkin layer (you chose scenario-level, not Gherkin) — journeys map to
  Playwright/Vitest describe-blocks named after §4's journeys, keeping traceability without a
  translation layer.
- No new assertion or mocking framework — Playwright's built-ins + Vitest `expect` suffice.
- No visual-regression or a11y tooling in v1 (follow-on).

---

## 9. CI wiring & the release gate

### 9.1 How the gate is run

The gate is the **external suite pointed at a running target** — run on demand by a developer
(against a local instance) or by a scheduled/triggered pipeline (against a deployed dev
instance). There is no CI-managed stack at this stage.

| When | Target (config) | Tiers | Blocking |
|---|---|---|---|
| Developer, pre-merge, locally | `local` | G1 + G2 (+ G3 if a peer is configured) | advisory (local) |
| Against the deployed **dev** build, before promoting a release | `dev` | G1 + G2 + G3 | **Yes — this is the release gate** |
| Scheduled nightly against `dev` | `dev` | G1 + G2 + G3 | Reported, triaged next morning |

The **release gate** = the external suite passing against the **dev** deployment (the candidate
build already deployed there), per the pass/fail criteria in §1.3. Keeping G2/G3 heavier tiers
to the dev-target runs keeps the local loop fast; a developer typically runs G1 (and the UI
happy paths) against local before pushing.

### 9.2 Pipeline jobs

**Existing per-PR CI (G0) — extend with:**

1. **`integration` (G0 gap-closer, highest ROI):** bring up `db` + `redis`, apply schema
   (`db:push` + `db:init`), then `pnpm --filter api test:integration` (`fileParallelism:false`,
   free port 2742). This is the **inject-based** integration layer — the one place a DB is
   provisioned in CI; it is *not* the external E2E suite. It closes the "integration tests never
   run in CI" gap and is the prerequisite for everything else.
2. **`lint` (G0):** currently absent — cheap, catches a class of regressions early.

**External E2E (G1/G2/G3) — no stack brought up; runs against a deployed target:**

3. **`e2e` job:** checkout → `E2E_ENV=dev pnpm e2e` against the deployed dev instance; upload
   Playwright traces/videos/HTML report + notification-stub dumps as artifacts (sharded for
   G2). All target coordinates and capabilities come from `config/e2e/dev.json`, with secrets
   (service key, db url) injected from the pipeline's secret store — never committed.

Wiring job 3 to a specific trigger (post-deploy-to-dev, nightly, or manual `workflow_dispatch`)
is an operational choice; the suite itself only needs a reachable target + its config.

### 9.3 Reporting & artifacts

- Every tier emits a machine-readable result (JUnit/JSON) plus a human summary posted to the
  PR / release checklist: pass counts by priority (P0/P1/P2), the exact failing journeys, and
  linked traces.
- G2/G3 attach Playwright traces + notification-stub dumps on failure so a red gate is
  diagnosable from CI alone (no "works on my machine" round-trips).
- A **coverage traceability report** (§10) is generated per run: any P0 endpoint/screen/
  invariant with no mapped passing test **fails the gate** — this prevents silent coverage
  rot as the app grows.

### 9.4 Flake budget & quarantine

- A gate that's flaky gets ignored, which is worse than no gate. Policy: **P0 tests may not
  be quarantined** — a flaky P0 is a bug in the test or the product and blocks until fixed.
- Non-P0 flakes may be quarantined **with a linked issue and an expiry date**; quarantined
  count is reported and capped (e.g. ≤ 3). Retries are allowed only with trace capture, and a
  test that only passes on retry is flagged, not celebrated.

### 9.5 Runtime discipline

Wall-clock targets are in §1.2. Levers to stay within them: shard Playwright, run matrix cells
in parallel against the shared target, reuse one authenticated session/fixture set across a
tier, and keep G2 to **one representative happy path per journey** (depth lives in G1).

---

## 10. Coverage traceability matrix

The gate is only credible if every P0 surface is provably mapped to a test. This matrix is
the contract; it is regenerated and checked each run (§9.3). Abbreviated here (the living
version is maintained alongside the suite):

| Journey | Primary endpoints / screens | Key invariants guarded | Layer | Priority |
|---|---|---|---|---|
| A Self-signup→profile | `/auth/config`, `/api/auth/*`, `/consent/accept`, `/item/create`, `/network/item/fetch` · login/otp/profile-form pages | consent-gates-discoverability, backend URLs, completion=required | G1+G2 | P0 |
| B Gated signup block | `check-user`, `requestOtp`, `verifyOtp`, `/admin/participant` | gate fail-closed, admin-domain exempt, no OTP leak | G1+G2 | P0 |
| C U18 guardian | `/auth/u18-precheck`, `/consent/u18/*` · guardian flow UI | guardian single-source, fail-closed null DOB, both promotion paths, no over-fire | G1+G2 | P0 |
| D Action→event | `/action/perform`, `/action/update-status` · action modal | single-object, live-on-both, consent snapshot immutable | G1+G2 | P0 |
| E Bulk actions | `/action/perform/bulk`, `/update-status` · bulk bar | envelope shape, partial failure, limits | G1+G2 | P1 |
| F PII reveal | `/action/:id/contact-details` · contact modal | participant+status gated, config-driven set, per-read recompute, audit | G1+G2 | P0 |
| G PII at rest | `/item/fetch`, `/network/item/fetch` (DB rows) | encrypted state, masks, cache-key scope, jitter determinism | G1 | P0 |
| H Discovery | `/item/fetch`, `/network/item/fetch` · home/map | two paths, live-only, complete-aggregate cache, best-effort XADD | G1+G2 | P0 |
| I Service auth | `/admin/aggregator/upsert`, `/admin/participant*`, on-behalf `/action/perform` | apikey-priority, check order, tier matrix, ownership scoping | G1 | P0 |
| J Dashboard | `/aggregator/dashboard`, `/export` | config buckets, advisory-lock recompute, exact runbook counts | G1 | P1 |
| K Consent ledger | `/consent/*` | server-derived version, append-only/seq, rollback, per-network categories | G1 | P0 |
| L UI cross-cutting | theming, i18n, served-binding, tourist, `/support` | runtime-config precedence, host routing, localization scope | G2 | P1 |
| M Wallet import | wallet/DigiLocker modals (stubbed) | VC→form mapping, provider gating | G2 | P2 |
| N Multi-instance | `/network/item/fetch`, `count_local`/`fetch_local`, `/network/action/perform` | peer HMAC, complete-aggregate cache, cross-instance PII refusal, entry-only consent | G3 | P0 (Ph2) |

Plus the §5 guard tables (auth boundaries, consent/U18 fail-closed, PII non-leakage,
contract integrity, resilience) — each row is a P0 test mapped to its journey.

**Coverage rule:** a new API route or UI screen that touches a P0 surface must arrive with a
mapped E2E test, or the traceability check fails the gate. This keeps the gate honest as the
product evolves (the app is actively changing — new consent flows, action variants, and
served-binding modes have all landed recently).

---

## 11. Phased rollout plan & risks

### 11.1 Phases

**Phase 0 — Close the CI gap (days, not weeks).**
- Add the `integration` CI job so `test:integration` actually runs on PRs (§9.2 #1).
- Add a lint job.
- *Outcome:* the existing 18 integration suites become a real gate immediately — the single
  highest-ROI step, and a prerequisite for the harness.

**Phase 1 — Single-instance functional gate (G1 then G2).**
- Build the external harness + `config/e2e/{local,dev}.json` (§8.3): the typed HTTP client,
  Playwright with runtime-config injection, the OTP/notification-stub oracles, and the
  capability-tag/skip runner.
- Build G1 API journeys A–K (skip N) across the representative matrix; run against a local
  instance in dev and against the dev deployment for the gate.
- Build G2 UI happy paths for A, C, D, F, H, L (the UI-risk journeys); same targets.
- *Outcome:* ~90% of release risk covered; the gate can block a bad release.

**Phase 2 — Network-aware gate (G3).**
- Point the suite at two running peer instances (`peer.apiBaseUrl`) + peer-auth matrix +
  cross-instance PII/consent (§6).
- *Outcome:* the network-aware peer surface — the part unique to this product — is gated.

**Phase 3 — Hardening (ongoing).**
- Flake burn-down to within budget; traceability check enforced; add a11y/visual-regression
  and performance gates as follow-ons.

### 11.2 Key risks & mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Flaky gate gets rubber-stamped** | Gate loses all value | P0 no-quarantine policy, flake budget, retries only with trace, quarantine expiry (§9.4) |
| **Schema-driven brittleness** (a network.json change breaks many tests) | High maintenance | Parametrize from `examples/schemas/**` + `resolveBindings()`; assert *behavior/invariants*, not hardcoded field lists |
| **Multi-instance topology is hard to keep stable** | G3 flaky/slow | Phase it second; run against a stable pre-provisioned two-peer dev topology given via config; keep G3 to the named scenarios only |
| **Dev target can't be stubbed / fault-injected** | Some guards uncoverable on dev | Capability-tag those tests; run them against a local instance wired to stubs; skip-and-report on dev (§8.3) — never silent-pass |
| **Spec/code drift** | Tests assert stale behavior | Code is source of truth; invariants cross-checked against code, re-checked when a spec changes |
| **OTP/consent journeys untestable headlessly** | Core journeys uncovered | Target launched with `CREATE_TEST_OTP=true`; OTP mode + notification-stub declared in config |
| **Gate too slow → bypassed** | Devs route around it | Run G1 (+ UI happy paths) against local before push; heavier G2/G3 against dev; shard; wall-clock targets enforced |
| **Coverage rot as app grows** | Gate silently stops covering new surface | Traceability check fails the gate on unmapped P0 surfaces (§10) |
| **Partition/data-isolation bugs in tests** | Cross-test pollution | `is_test` tag cleanup, per-suite ownership, namespaced identifiers (§7.2) |

### 11.3 Definition of done for the gate

The gate is "done" (v1) when: Phase 0 + Phase 1 are complete; all P0 journeys and all §5 guards
are green when the external suite runs against the dev deployment; the traceability check runs
and passes; the flake budget is met for two consecutive weeks; and a developer can reproduce
any gate failure by pointing the suite at a local instance (`E2E_ENV=local`). Phase 2 promotes
the gate to full network-aware coverage.

---

## Appendix — anchor files for implementation

- **Rules:** `.claude/rules/{consent-v1,auth-model,network-fetch,database-conventions,env-vars}.md`
- **Operations:** `docs/operations/{integrating-dpgs,e2e-purple-dot-runbook,guardian-otp-templates,secrets,migrations}.md`
- **Existing test scaffolding to build on:** `apps/api/src/routes/v1/__tests__/integration_helpers.ts`, `u18_test_helpers.ts`, `apps/api/vitest.integration.config.ts`, `apps/api/vitest.setup.ts`
- **Deterministic fixtures / operator E2E:** `apps/api/scripts/e2e/` (`seed_actions.mts`, `generate_fixtures.mts`, `purple_dot_*` fixtures), `docs/operations/e2e-purple-dot-runbook.md`
- **Schemas-of-record:** `examples/schemas/{blue_dot,purple_dot,yellow_dot,orange_dot,inter-network-action}/`
- **Environment:** `signals-dpg/local-setup/` (`docker-compose.yml` + `LOCAL_SETUP.md`); `signals-dpg/docker-compose.yaml` (db+redis); `packages/config/src/secrets.ts`
- **CI to extend:** `.github/workflows/ci.yaml`

---

### In plain terms

Right now the app has good "small" tests (checking individual functions and single API
endpoints), but nothing that proves a whole real user journey works from start to finish —
and some of the existing tests don't even run automatically before a release. This document
designs that missing safety net: a set of automated tests that act like a real person
using the app end to end — signing up, getting a one-time code, creating
a profile, connecting with someone, a parent approving for a child, private contact details
being revealed only after both sides agree — and checks that all the important safety rules
still hold. If any of these break, the release is stopped. We roll it out in stages: first
turn on the tests that already exist, then add full journey tests for a single deployment,
then add the harder tests that involve multiple connected deployments talking to each other.
