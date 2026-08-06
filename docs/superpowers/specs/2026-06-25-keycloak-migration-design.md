# Keycloak Migration & Shared IAM — Design (Signals + Aggregator)

**Date:** 2026-06-25 · **Branch:** `feat/keycloak-migration` (off `feature`)
**Scope:** Signals-DPG + aggregator-dpg. ai-diffusion-dpg is future-scoped (see §11).
**Status:** Design — **provisional**, pending product answers to `2026-06-25-iam-auth-open-questions-for-product.md`. Foundational premises (P1–P4) are engineering strawmen for product to confirm/adjust.
**Prerequisite for:** `2026-06-25-consent-management-design.md` (consent keys on the Keycloak `sub`).

## 1. Goal

Move Signals-DPG off **better-auth** and onto **Keycloak** as the shared identity provider for the network, unifying **human login**, **service-to-service identity**, and **cross-instance trust** under one realm — so a principal has **one Keycloak `sub`** everywhere. This is the hard prerequisite the consent system depends on, and it is the lever for fixing cross-instance actions and tightening PII/least-privilege access.

We are explicitly **rekeying to `sub` and rebuilding clean** rather than wrapping the legacy UUID/`request.user` model — accepting migration cost to avoid carrying an identity model that doesn't serve us.

## 2. Provisional premises (P1–P4) — product to confirm

These are engineering defaults chosen so design can proceed; each is flagged in the relevant product question.

- **P1 — Identity scope (§1 of questions doc):** one person = **one `sub`**, registered **once per network**, recognized across all instances (`up-blue`, `ka-blue`) and the aggregator. ⇒ identities live in a **single network-wide realm**; IAM is **centralized per network**.
- **P2 — Cross-instance (§6):** cross-instance discovery + action **is in scope**; tokens/permissions honored **network-wide**.
- **P3 — Roles (§2, §3):** operators = org **owner → admin → member** (two-level approval: network-admin approves org, org-admin approves sub-users); participants = seeker **XOR** provider, **role modeled as mutable**; services = **per-service scoped accounts**; network admin = **bounded** super-admin.
- **P4 — Multi-domain (§1.3):** blue+purple within one network ⇒ **one identity**, shared core attributes (Beckn-v2 registry direction), role/items scoped per domain. *(Shakiest premise.)*

## 3. Realm topology & identity model

**Realm = network.** One Keycloak realm per network (e.g. `blue_dot`). All instances of that network and all aggregators in it share it ⇒ **one `sub` per network**, honored across every instance (makes P1/P2 work). Separate networks = separate realms. Domains within a network (P4) stay in the same realm, scoped by attribute.

```
realm: blue_dot
├── clients
│   ├── signals-ui        (public, Auth Code + PKCE)        — participant login (via BFF, §6)
│   ├── signals-api       (bearer resource server)          — validates JWT via realm JWKS
│   ├── aggregator-portal (confidential, Auth Code + PKCE)  — operator login
│   ├── aggregator-api    (service account, client_creds)   — admin ops
│   ├── voice-bot         (service account, scoped)          — external agent
│   └── consent-service   (bearer resource server)
├── groups
│   ├── /operators/{org_id}   (org membership + org_role: owner|admin|member)
│   └── /participants
└── token claims (protocol mappers)
    ├── participant: participant_role (seeker|provider), user_status, network
    └── operator:    org_id, aggregator_type (seeker|provider), org_role, decision_made
```

- The **`sub` is the canonical cross-service identity** (consent, cross-instance, aggregator key on it).
- **Authz is attribute/group-based** (mirrors the aggregator): the API derives role/org/scope **only from verified token claims**, never from client input. No reliance on Keycloak's built-in resource-permission engine.
- **Network admin** = realm-level bounded admin (approve orgs, publish schemas/consent docs); exact powers product-confirmable (§10.1 of questions doc).

## 4. Identity key on `sub`, built clean

**4.1 The `sub` is THE user key across Signals** — no local surrogate UUID. App tables store the `sub` directly (`items.created_by`, `item_actions.{source,target}_item_owner` + `performed_by_service_user_id`); these are plain text columns today, so they hold a `sub` as readily as a UUID.

**4.2 Thin local identity projection.** A `user_projection` table keyed by `sub` (PK) holds only what Signals needs for **joins, display, and status-gating** (name, phone, email, `participant_role`, `user_status`, network, `legacy_user_id` for traceability). **Source of truth = Keycloak**; synced on provisioning (admin API) and on change (Keycloak event/webhook, or lazy refresh-on-read). Avoids per-request IdP calls.

**4.3 Org membership/roles live in Keycloak groups**, surfaced as claims. The local `member` table is **retired as an authz source** (`organization` kept only for business data beyond identity).

**4.4 `request.identity`** — a typed, minimal, claims-derived shape (replaces the better-auth `request.user` grab-bag):
```
request.identity = {
  sub, network, roles[], participant_role?,
  org?: { id, type, role }, status, auth_method: 'session' | 'service'
}
```
Call sites are refactored to consume `sub` + this shape (accepted overhead / cleanup).

**4.5 Token verification** — a shared `jose`/JWKS verifier module (issuer + audience + signature), reused by `signals-api`, `consent-service`, and future services. Mirrors the aggregator's `access-token.ts`.

## 5. Login & OTP

- **Keycloak owns authentication.** No app-layer auth survives. The SPA uses **Auth Code + PKCE** (via the BFF, §6).
- **Phone/email OTP = a custom Keycloak authenticator.** Reuse/extend the **aggregator realm's existing phone-OTP authenticator** (reads `phoneNumber`). Flow: enter phone/email → authenticator calls **notification-service** to send OTP → verify → authenticated; **first-time auto-provisions** the Keycloak user. The `unified_otp` plugin + endpoints + Redis-OTP logic are removed.
- **Login capability-gating differs from consent:** login **cannot** degrade to "unverified" — a verified channel is required. The per-instance provider flag decides **which login methods exist** (SMS→phone OTP, SMTP→email OTP, optional password).
  - ⚠️ **Constraint:** a **phone-only user on an instance with no SMS provider cannot log in** — that instance must offer email OTP or password, or configure SMS. Ops/product decision per instance.
- **Business onboarding stays app-side**, in the first authenticated session: collect **DOB, participant role, run consent capture** (writing DOB/role back as Keycloak attributes). Keeps Keycloak customization minimal. This is the consent **creation-gate** point (`auth_method='session'`).
- **Dev/test** fixed-OTP mode (today's `CREATE_TEST_OTP`) preserved in the authenticator/notification path.

## 6. Session model — BFF folded into signals-api

The Signals UI is a **Vite SPA** (no server today). Decision: **fold a BFF into `signals-api`** (Fastify) rather than ship browser tokens or a separate service.

- `signals-api` gains OIDC routes (`/auth/login`, `/auth/callback`, `/auth/logout`) + a **server-side session**: **httpOnly cookie** (`sid`) + **Redis token store**, server-side code-exchange and refresh. The SPA calls the API with the cookie; the API attaches the Bearer. **Tokens never reach the browser** (XSS-safe). Reuses the aggregator's session-store/refresh patterns.
- `signals-api` is simultaneously a **Bearer resource server** for service traffic (aggregator/voice) — different route groups, one app.
- **Short-lived access tokens (~5 min) + rotating refresh**; **RP-initiated logout** clears the Keycloak SSO session.
- **Cross-instance:** the token is a **network-realm** token, so one session authenticates against any instance's API; switching instances is a silent SSO re-login.

## 7. Service-to-service identity & authorization

- **Service accounts replace API keys.** Every integrator (each aggregator, voice bot, each network instance) is a **Keycloak client with a service account**, using **client_credentials** + Bearer. The `apikey` table, the `@better-auth/api-key` plugin, and the shared "network-service" key are **retired**. **Per-service clients** ⇒ revoke/re-scope one without affecting others.
- **Least-privilege scopes**, defined and enforced per route: e.g. `participant:onboard`, `item:write:on_behalf`, `action:perform:on_behalf`, `user:read`, `action:read`, `network:federate`. Each service granted only what it needs.
- **Acting-on-behalf attribution (answers §10.2):** the service token authorizes; the request names the target participant `sub`. Signals records the truthful triple — **`performed_by` = service/client**, **`on_behalf_of` = participant `sub`**, **`acting_org` = `org_id` claim**. `x-acting-org-id` is **dropped** (token-derived; transitional accept during cutover).
- **Cross-instance / federation trust (P2 + closes the unauthenticated gap):** instances share the realm, so a peer validates a realm-issued token (issuer/JWKS) carrying a **`network:federate`** role. Participant `sub` is network-wide ⇒ cross-instance on-behalf actions are recognized everywhere.
- **Voice bot:** its own **scoped client** (`user:read` + granted item/action CRU), acting **on behalf of the caller's `sub`**, resolved via phone → `sub` (`user:read` on the `phoneNumber` attribute). *(Confidence that the phone proves the caller = the consent doc's voice caller-auth open question — separate policy call.)*

## 8. Migration & cutover

Sequenced to stay reversible until the last step.

- **Phase A — Realm + scaffolding (no cutover).** Create realm + clients + reused phone-OTP authenticator + claims/groups/scopes. Build the shared `jose` verifier, `signals-api` Bearer validation, and the BFF **behind a flag, in parallel with better-auth**. Create `user_projection`.
- **Phase B — Provision identities (bulk pre-provision).** Admin-API create a Keycloak user per existing better-auth user (phone/email/name/DOB + attributes), recording a permanent **`old_uuid → sub` map**. **Fold the `aggregator` realm operators** into the network realm (preserving `org_id`/`type`/`decision_made` + groups). **Network-level dedup by phone/email** — same person across instances or participant-who-is-also-operator ⇒ **one `sub`** (must be network-level, not per-instance, or P1/P2 break).
- **Phase C — Rekey data.** `UPDATE … FROM` the `old_uuid→sub` map across the **partitioned** item tables + `item_actions` (owners + `performed_by_service_user_id`) + member refs, **batched per partition**, with **before/after count verification** and explicit **orphan-owner** handling. Populate `user_projection`. Snapshot before this phase.
- **Phase D — Cutover (dual-run).** Flip `auth_middleware` to Keycloak + enable BFF; switch UI to OIDC. Integrators move `x-api-key` → client-credentials with a **transitional dual-accept** window, then drop `x-api-key`. Consent re-prompt (no-backfill) fires on first post-cutover login.
- **Phase E — Teardown.** Drop better-auth tables (`account`, `verification`, `apikey`, `session`), remove `unified_otp` + better-auth deps, drop legacy surrogate columns, decommission the standalone `aggregator` realm.

## 9. What's removed vs kept

- **Removed:** better-auth instance, `@better-auth/api-key` + `apikey` table, `getSession`, `unified_otp` plugin + endpoints, `account`/`verification`/`session` tables, the local UUID surrogate, `x-acting-org-id` (post-cutover), the local `member` table as an authz source, the standalone `aggregator` realm.
- **Kept / new:** `user_projection` (sub-keyed), `organization` (if it carries business data), the shared `jose` verifier, the reused phone-OTP authenticator, per-service Keycloak clients.

## 10. Relationship to the consent design

- Consent records key on `sub` — satisfied by P1 (one `sub` per network).
- The consent **creation-gate** (`auth_method='session'`) fires at the §5 first-login onboarding step.
- The consent **capability-gated OTP** (guardian/proxy/voice) and this migration's OTP share **notification-service** and the **per-instance provider flag**.
- Cross-DPG erasure's actor attribution uses the §7 `performed_by`/`on_behalf_of` triple.

## 11. ai-diffusion-dpg (future-scoped)

Python/FastAPI; no unified auth today (web = Google SSO + HS256 JWT; **voice = phone-as-identity, no login**; service-to-service = static API keys). Bringing it onto Keycloak later: web channel = OIDC swap (medium); **voice = the hard problem** (phone→`sub` without an interactive login — same crux as §7's voice bot and the consent voice caller-auth question); service-to-service = client-credentials. Out of scope for this design; reviewed separately.

## 12. Testing

- **Token verification:** signature/issuer/audience validation; expired/forged tokens rejected; JWKS rotation.
- **Middleware:** session vs service classification; `request.identity` projection; `auth_method` marker; `AUTH_MIDDLEWARE_ENABLED` kill switch.
- **Login:** phone & email OTP authenticator (send via notification-service, verify, auto-provision); dev fixed-OTP; phone-only-no-SMS fallback behavior.
- **BFF:** code exchange, cookie session, refresh rotation, logout (RP-initiated); tokens absent from browser.
- **Service auth:** client-credentials acceptance, per-scope route enforcement, on-behalf attribution triple, `network:federate` cross-instance.
- **Migration:** provisioning idempotency + network-level dedup; rekey correctness (count parity, orphan handling) on partitioned tables; dual-accept window; rollback via the map.
- **Cross-instance:** a session/token minted at instance A authorizes an action at instance B.

## 13. Phasing (tracks → plans, per branch-per-plan)

Three tracks; phases A–E (§8) cut across them:
1. **Signals human-user migration** off better-auth (realm/clients, authenticator, BFF, identity projection, rekey, cutover).
2. **Service-identity unification** (service accounts + scopes, on-behalf attribution, cross-instance federation trust, retire `x-api-key`).
3. **ai-diffusion** (future, §11).

## 14. Open questions & dependencies

- **All of `2026-06-25-iam-auth-open-questions-for-product.md`** — P1–P4 and the role/PII/lifecycle/admin specifics are provisional until answered. Realm topology (§3), the scope catalogue (§7), and the gating rules depend on them.
- **Phone-only + no-SMS login gap** (§5) — per-instance fallback decision (ops/product).
- **Voice caller-auth confidence** (§7) — shared open question with the consent design.
- **Rekey scale/downtime** (§8 Phase C) — partitioned-table rewrite needs a sizing + online-vs-window decision.
- **Keycloak customization ownership** — the custom authenticator is a Java SPI; confirm who maintains realm/SPI artifacts (infra/automation repo).
