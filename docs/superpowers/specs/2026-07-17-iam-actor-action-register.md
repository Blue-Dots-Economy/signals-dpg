# IAM & Auth — Actor & Action Register (canonical)

**Date:** 2026-07-17 · **Branch:** `feat/keycloak-migration` (off `feature`)
**Status:** Design — canonical **actor register**. This is the source-of-truth enumeration of *who* authenticates, *what* they may do, and *how they are modeled in Keycloak + OPA*. It feeds and will be referenced by `2026-07-08-multi-instance-iam-design.technical.md`, `2026-06-25-keycloak-migration-design.md`, and the consent designs.
**Substrate (settled):** B1 — instance-local Keycloak realm **shared by aggregator + signals** (`bluedots`; one `sub` per human across both DPGs per instance) as the account authority; a Keycloak-based **network registry** (instances as clients) for routing + cross-instance trust; **no mandatory per-participant PID**; **Aggregator = operating unit**, humans are members with RBAC roles.

---

## 1. Purpose & scope

This register redefines the IAM/Auth model from the actors up. It exists because identity and authorization are currently fragmented across the ecosystem: **five** coexisting auth schemes (better-auth `x-api-key`, Keycloak OIDC/JWT, and three HMAC variants — `x-dpg-*`, `X-NS-*`, `x-instance-*`), a shared "network-service" key whose bearer can name any `user_id`, and two services (match-engine, signals-search) that bypass request-auth entirely by sharing Signals' Postgres directly. The register names every principal, states its capabilities and boundaries across present and future, and pins how each maps onto **Keycloak (authentication)** + **OPA (authorization)**.

**In scope:** all human users, first-party internal service apps, external service clients, and cross-instance/network actors that touch identity, data, or actions across Signals-DPG, aggregator-dpg, signals-search, notification-service, and ai-diffusion-dpg.

**Explicitly excluded:** `match-engine` and `dpg-scoring` are **out of scope for this register** (per current direction). They still exist; their identity model is deferred.

**Column legend** (the "5W+2H", applied per actor):

| Column | Meaning |
|---|---|
| **Who** | the actor + class + present / future |
| **What** | capabilities / actions (verbs, scopes) |
| **When** | lifecycle trigger / gating condition under which it acts |
| **How** | authentication mechanism (today → target) |
| **Until** | credential lifetime / validity (token TTL, session, single-use, until-revoked/offboarded) |
| **Where** | scope boundary: which realm/instance, which services, which data |
| **Why** | purpose / least-privilege rationale that justifies the grant |
| **KC + OPA** | how it's modeled: realm role / group / client type / attributes / scopes; OPA policy inputs |
| **Relations** | parent/child, member-of, acts-on-behalf-of |

---

## 2. Substrate recap

- **Identity is instance-local (B1).** Each instance runs its own Keycloak realm; `sub` is the identity key *within* that realm. Same phone at two instances = two accounts, two `sub`s, **no dedup** (product-stated).
- **Realm topology — SHARED per-instance realm (DECIDED 2026-07-29, architect).** Within an instance, aggregator and signals share **one realm** (`bluedots`); a human is **one subject with one `sub` across both DPGs** in that instance. *A per-DPG-realm alternative was raised and recommended* (it would let the same phone/email register as **separate independent accounts** on each DPG — for which there is no product ask to restrict — and would avoid the UUID-preserving user-copy collision and the aggregator-portal entitlement-gate cost); **the architect chose the shared realm.** Consequences accepted: email/phone uniqueness spans **both** populations (same person = one identity across both DPGs within the instance); `signals-api` must validate `aud`/`azp` + required realm role (an aggregator-issued token is realm-valid); realm roles share one namespace; cross-DPG `sub` is shared (enables cross-DPG consent within an instance). `sub` is still **not** shared across instances (realm = instance boundary).
- **Network registry lives in Keycloak.** Instances are registered as **clients** in a network-level registry so peers can discover/route and validate each other's tokens. This replaces the standalone "mint a PID for every participant" requirement — routing and cross-instance trust are **instance-level**, not per-person.
- **PID is optional / deferred.** A network-wide *participant* identifier is modeled only as `(planned, if a use case forces person-level correlation)`. Nothing in this register depends on it.
- **Aggregator = operating unit.** The Aggregator is a **non-login** operating identity that owns a `signalstack_org_id` and a type (seeker|provider) and appears as `acting_org` on Signals data. **Humans (Coordinator/Admin/Owner) are members** of an Aggregator with RBAC roles — many humans can operate one Aggregator.
- **Ownership is item-level.** An Aggregator owns specific **items** of a Signals user, not (necessarily) the whole user account. A single user's items may be owned by different aggregators.

---

## 3. AuthN / AuthZ architecture

Two layers, cleanly split:

**Keycloak = authentication + verified claims.** Owns login (Auth Code + PKCE for humans, client-credentials for services, phone/email-OTP authenticator), issues short-lived access tokens carrying identity (`sub`), roles, org/aggregator-unit membership (group claims), and granted scopes. It asserts *who you are and what you were granted* — nothing about a specific resource.

**OPA = the policy decision point (PDP) for all business authorization.** Every allow/deny that depends on a *rule* is an OPA query. OPA evaluates over:

```
decision = f(
  token claims ∧ granted scopes,          # from Keycloak
  resource ownership (item-level),          # who owns this item
  discoverability / actionability flags,    # per item AND per action
  consent / terms state,                    # per item AND per action
  delegation validity                       # is the on-behalf-of chain legitimate
)
```

**The hybrid boundary (recommended, chosen).** The resource server (signals-api, search) performs standard **OAuth2 bearer-scope admission** first — cheap, rejects tokens that don't even carry the coarse scope — then calls **OPA for the actual decision**. The coarse layer is token validation, not bespoke logic; OPA remains the single authority for every business rule (ownership, consent/terms, discoverability/actionability, delegation). *Phasing:* KC scope-gating ships first; OPA policies layer on (so early delivery is implementable on Keycloak alone, converging to OPA as the PDP).

**Delegation is first-class and mandatory for user data.** Class B/C services rarely act purely as themselves; they act **on behalf of** a Class A human. The rule: **any access to a specific user's items/actions MUST carry that user's (or an authorized operator's) delegated token** via OAuth2 **token exchange (RFC 8693)** — no service may touch user-scoped data on its bare client identity. Pure service identity is permitted only for non-user, aggregate/system operations. This closes the shared-key "client-set `user_id`" bypass. Every access records the truthful **actor triple**:

```
performed_by = the service/client (azp)       on_behalf_of = the participant (sub / user ref)
acting_org   = the Aggregator operating unit (unit claim)
```

```
Class A human ──login──▶ Keycloak (instance realm) ──token{sub, roles, unit, scopes}──┐
   │                                                                                   │
   └── delegates (token exchange) ──▶ Class B/C service ──{service_id + on_behalf_of + scopes}──┐
                                                                                                │
                        signals-api / search:  (1) OAuth2 scope admission (coarse)              │
                                               (2) OPA query (ownership ∧ discover/action ∧      │
                                                   consent/terms ∧ delegation)  ◀───────────────┘
                                               → allow/deny → record actor triple
```

---

## 4. Actor taxonomy

- **Class A — Human users** (interactive logins): Network Admin, Network Facilitator operator, Org Owner, Org Admin *(future)*, Coordinator, Aggregator Admin/Member *(future)*, Participant/User, Guardian/Proxy *(future)*.
- **Class B — Internal service apps** (first-party, per instance): signals-ui, signals-api, aggregator-portal, aggregator-api, signals-search, notification-service, ai-diffusion services.
- **Class C — External service clients** (third-party agents): Raya voice bot, Campaign orchestrator prototype (Operation Rozgar), other integrating DPGs / external agents.
- **Class D — Cross-instance / network actors**: Peer instance, Network Registry / Facilitator service.

---

## 5. Hierarchy & relations

The Aggregator/Coordinator **decoupling** is the load-bearing structural change: today a Coordinator *is* an Aggregator (one Keycloak user carries the `aggregator_id` claim and owns the `signalstack_org_id`). The target splits the **operating unit** from the **human logins**.

```
Network Facilitator ──admits──▶ INSTANCE (registered as a client in the KC network registry)
        │
Network Admin ──approves──▶ ORG  (aggregator_orgs — governance unit)
                             │   Owner (human login, role: org_owner)
                             │   Org Admin (human login, role: org_admin)        ── future tier
                             ▼   (owner/admin approve & manage the level below)
                          AGGREGATOR  (operating unit — owns signalstack_org_id + type seeker|provider;
                             │          appears as acting_org on Signals data; NOT a login)
                             │   Coordinator (human login, member, role: coordinator)
                             │   Aggregator Admin / Member (human logins)          ── future multi-user RBAC
                             ▼   (many humans → one Aggregator)
                          PARTICIPANT'S ITEMS  (Signals user + item; each item owned by an Aggregator-unit)

Attribution on every mutation:  acting_org = Aggregator-unit · performed_by = human sub · on_behalf_of = participant
```

Key relation facts:
- A **Coordinator** may be a member of **multiple** Aggregators.
- An **Aggregator** may have **many** human members (owner-approved), each with a role — this is the multi-user RBAC target.
- **Ownership binds an Aggregator to a participant's *item*, not the participant's account.** A participant's items may be spread across different Aggregators.
- The **future Admin tier** (Org Admin, Aggregator Admin) is purely a role at the human-login layer — no new unit, no data-model change beyond a role value.

---

## 6. The Actor & Action Register

> Cells are terse; nuance is in the notes beneath each table. "today→target" in **How** shows the migration.

### 6.A Human users (Class A)

| Who | When (P/F) | What | How | Until | Where | Why | KC + OPA | Relations |
|---|---|---|---|---|---|---|---|---|
| **Network Admin** | P | Approve orgs; publish schemas / consent docs / network.json; receive complaints | OIDC session (today: N/A in Signals; target: KC Auth Code+PKCE via BFF) | session; role until revoked | own instance realm; signals-api admin + aggregator | Bounded network-level governance | realm role `network_admin`; OPA: admin-scope rules | governs Orgs; admits below via approval |
| **Network Facilitator (operator)** | P/F | Admit/route instances; run the network registry; hold cross-instance trust config | OIDC session at the network-registry realm | session; until revoked | **network registry realm** (not an instance realm) | Operate the network as a whole | realm role `network_facilitator` at the registry; OPA: registry-admin rules | admits Instances (D1); may overlap Network Admin in S1 |
| **Org Owner** | P | Approve/offboard coordinators & aggregators in the org; transfer ownership; view org data | OIDC Auth Code+PKCE via portal BFF; phone-OTP | session; role until transferred/offboarded | own realm; aggregator-portal + org-scoped reads at signals-api | Govern one Org | realm role `org_owner`; group `/orgs/{org_id}`; OPA: org-scoped ownership | owns Org; approves Coordinators/Admins |
| **Org Admin** | **F** | Delegated org management (subset of owner) | as Org Owner | session; until revoked | as Org Owner, minus transfer/offboard | Scale org admin without granting ownership | realm role `org_admin`; same group; OPA: subset policy | member-of Org; below Owner |
| **Coordinator** | P (decoupled) | Onboard participants; CRUD **items owned by their Aggregator**; gated+audited PII read | OIDC Auth Code+PKCE via portal BFF; phone-OTP (today: KC realm `aggregator`) | ~5 min access token + rotating refresh; role until reassigned | own realm; aggregator-portal → signals-api; data = items where `acting_org` = their Aggregator | Ground onboarding & profile ops on behalf of participants | realm role `coordinator`; **member of group `/aggregators/{aggregator_id}`** (no longer *is* the aggregator); OPA: item-level ownership ∧ PII-consent | member-of Aggregator(s); acts on-behalf-of Participant |
| **Aggregator Admin / Member** | **F** | Multi-user RBAC under one Aggregator (roles: admin/operator/read-only) | as Coordinator | session; until revoked | scoped to their Aggregator's items | Let several humans operate one Aggregator | roles under `/aggregators/{aggregator_id}`; OPA: role×item policy | member-of one Aggregator |
| **Participant / User** (seeker \| provider \| both) | P | Manage own account + items; initiate/accept actions (connect/apply); grant/withdraw consent | KC Auth Code+PKCE via signals-api BFF; phone/email-OTP (today: better-auth) | ~5 min token + refresh; account until erasure | own realm/instance; own items + actions | Own and act on one's own participation | groups `/participants`; attributes `participant_role`, `user_status`; OPA: self-ownership ∧ consent | owns own items; counterparty in actions |
| ↳ *coordinator-onboarded participant* | P | May have **no login**; data acted on by a Coordinator on-behalf-of | none (proxy) | n/a | as above | Reach users who don't self-serve | user record without KC credential; item `acting_org` set | on-behalf-of by Coordinator |
| **Guardian / Proxy** | **F** | Act on behalf of a participant under consent capability-gating | OTP-verified proxy channel | per-action / session; consent-scoped | own realm; the represented participant's items | Represent users who can't consent directly | proxy role + linkage attribute; OPA: guardian-consent rules | acts on-behalf-of Participant |

Notes: **Network Admin vs Network Facilitator** collapse into one human in the single-instance (S1) topology; they separate once a real network registry exists (S2+). The **coordinator-onboarded participant** is why on-behalf-of must be first-class (§3). `x-acting-org-id` is retired — `acting_org` becomes a **token claim** (the Aggregator-unit), which is precisely what the decoupling enables.

### 6.B Internal service apps (Class B)

| Who | When | What | How | Until | Where | Why | KC + OPA | Relations |
|---|---|---|---|---|---|---|---|---|
| **signals-ui** (SPA) | P (rework) | Participant/UI front-end; holds **no tokens** | public client, Auth Code+PKCE **via signals-api BFF**; tokens stay server-side (httpOnly cookie + Redis) | session cookie | browser ↔ signals-api | XSS-safe browser login | KC public client `signals-ui`; no OPA (delegates to api) | drives Participant login |
| **signals-api** (resource server + BFF) | P (rework) | Own canonical data; OIDC BFF; **PDP caller** (asks OPA); records actor triple | Bearer resource server + BFF OIDC routes (today: better-auth `x-api-key`/session → target: KC) | 5 min tokens; server session | its realm/instance | Canonical node + session broker | KC clients `signals-api` (bearer) + BFF; **calls OPA on every decision** | serves A, B, C, D; retires `apikey` table + `x-acting-org-id` |
| **aggregator-portal** (web) | P | Operator UI (owner/admin/coordinator) | confidential client, Auth Code+PKCE; Redis BFF session | session | own realm; browser ↔ aggregator-api | Operator front-end | KC confidential client `aggregator-portal` | drives A operator logins |
| **aggregator-api** | P (rework) | Write onboarding/items to Signals **on behalf of operators** | client-credentials **+ token exchange carrying the operator's `sub`** (today: `x-api-key` + `x-acting-org-id`) | 5 min service token; per-request delegation | own realm → signals-api | Bulk/registration writes for aggregators | KC service-account `aggregator-api`; scopes `participant:onboard`, `item:write:on_behalf`; OPA enforces item-level ownership | carries A operator auth (mandatory); `acting_org` from unit claim |
| **signals-search** | P (rework) | Query/read non-PII discoverable items | Bearer resource server; **validates same token, stops trusting caller / DB-bypass** (today: shares Signals DB + `x-api-key`) | token TTL | its realm/instance | Discovery over the read model | KC client `search-api`; scopes `search:query`, `search:read:non_pii`; **OPA filters by discoverability ∧ consent**, no PII | consumes A/B/C tokens; enforces consent on reads |
| **notification-service** | P (rework) | Send OTP / notifications | client-credentials (today: HMAC `X-NS-*`) | 5 min token / single message | callee | Multi-channel delivery + OTP for the KC authenticator | KC service-account `notification-service`; scope `notify:send` | called by signals-api, KC authenticator, aggregator |
| **ai-diffusion services** (reach/knowledge/…) | P/F (rework) | AI layer; web=OIDC, voice=phone-identity, internal hops | web: OIDC swap; internal: client-credentials (today: Google OIDC + static `X-API-Key`) | token TTL | own realm; → signals-api on-behalf-of caller | AI diffusion over participant data | KC clients per service; scopes least-privilege; OPA on user-data access | see Raya (C1) for the voice on-behalf-of crux |

Notes: the **DB-bypass** services (signals-search's shared-DB read, and match-engine — now out of scope) are the clearest fragmentation debt: they must move to **validating tokens + asking OPA**, not trusting the database connection. `signals-api` is unique — it is both a resource server *and* the **PDP caller**; it is where the actor triple is written.

### 6.C External service clients (Class C)

| Who | When | What | How | Until | Where | Why | KC + OPA | Relations |
|---|---|---|---|---|---|---|---|---|
| **Raya voice bot** | P (rework) | Read caller's items; **perform actions**; may act on items it does **not** own | client-credentials **+ on-behalf-of the caller** (voice = phone→identity resolution) | 5 min token; per-call | own realm → signals-api | Voice channel for participants | KC client `raya`; scopes `user:read`, `item:write:on_behalf`, `action:perform:on_behalf`; **must tag every item/action** (bot-1 created, bot-2 applied); OPA validates delegation | acts on-behalf-of Participant; phone-auth confidence = open policy |
| **Campaign orchestrator (Operation Rozgar prototype)** | P interim → F service | Campaign/bulk flows: cohort export, PII attach, Raya/email trigger | **interim:** authenticates as the **acting user** (network admin/org owner/coordinator token); **target:** service client | interim: user session; async job tokens | own realm → signals-api; async export → blob → pre-signed URL | Campaign management before it's its own DPG | interim: no service key, user token only; target: KC client `campaign` w/ voice-bot profile; OPA scopes exports to what that user may see | carries A operator auth (mandatory); user-scoped now → service-client later |
| **Other integrating DPGs / external agents** | P/F | Per-integration, least-privilege | client-credentials + on-behalf-of where user data is touched | token TTL; until revoked | own realm → signals-api | Third-party interop | KC client per integrator; scopes per grant; OPA per-object | acts as self and/or on-behalf-of A |

Notes: the current campaign/voice flows are the exact **shared-key + client-set `user_id`** bypass this register closes. Under the mandatory-on-behalf-of rule (§3), the prototype authenticates as the **acting user** now, and moves to a **service client with the voice-bot capability profile** when it becomes a DPG — same seam, no data-model change.

### 6.D Cross-instance / network actors (Class D)

| Who | When | What | How | Until | Where | Why | KC + OPA | Relations |
|---|---|---|---|---|---|---|---|---|
| **Peer instance** | P (rework) | Federated discovery reads; (planned) cross-instance action | today: HMAC `x-instance-token` (`PEER_AUTH_MODE` permissive→enforced) → **target: KC network-registry client + `network:federate`** | per-request token; single-network | peer's `*_local` routes | Make the network behave as one | registered as a **client in the network registry realm**; scope `network:federate`; peer validates issuer/JWKS locally; OPA still gates the resource | validated by the receiving Instance |
| **Network Registry / Facilitator service** | P/F | Register/route instances; hold cross-instance trust (JWKS/registry); (optional) person-level correlation | its own realm/clients | long-lived config; rotated keys | central network-registry realm | Routing + trust authority, PII-free | Keycloak-based registry (instances as clients); **no PID unless a use case forces it** | admits/lists Instances; operated by Network Facilitator |

Notes: the register **does not require a per-participant PID**. Cross-instance need is met by (a) instances registered as clients for trust, and (b) routing by instance. Person-level correlation across instances is `(planned, only if required)`.

---

## 7. Ownership, discoverability, actionability & consent

These are the **OPA policy inputs** that make §6's "Where/Why" enforceable. All four apply at **both the item and the action level**.

- **Ownership (item-level).** Each Signals **item** carries its owning **Aggregator-unit** (`acting_org`) and the participant it belongs to. Authorization to CRUD an item = the caller's scope ∧ *that item's* ownership. A user's items may be owned by different aggregators; there is **no account-level blanket ownership**.
- **Discoverability.** Each item **and action** carries a discoverability state. Discovery (search, federated reads) returns only discoverable, consented, non-PII projections. Non-discoverable items are **hidden from counterparties**, not merely write-blocked (bidirectional).
- **Actionability.** Each item **and action** carries an actionability state. A counterparty may initiate/accept an action only where actionability ∧ consent permit — gated at **both initiate and accept**.
- **Consent / terms.** Every item and action carries a consent/terms check. Reads (discovery, PII) and writes (actions) both consult consent state. PII reads additionally **force an audit row** (who/what/when/why).

OPA evaluates `caller-scopes ∧ item/action-ownership ∧ discoverability/actionability ∧ consent-terms ∧ delegation-validity` → allow/deny, and signals-api records the actor triple on every mutation.

---

## 8. Signals-DPG redesign / rework implications

This register implies concrete rework in Signals-DPG (the service you flagged as needing the most change):

1. **Retire better-auth.** Remove `unified_otp` plugin, `@better-auth/api-key` + `apikey` table, local UUID surrogate, `getSession`. Adopt a KC instance realm + phone/email-OTP authenticator (reuse the aggregator realm's phone-OTP SPI).
2. **Fold a BFF into signals-api.** OIDC routes (`/auth/login|callback|logout`), httpOnly cookie + Redis token store; tokens never reach `signals-ui`. `signals-api` is simultaneously a Bearer resource server for services.
3. **Retire `x-acting-org-id`.** `acting_org` becomes a **token claim = the Aggregator-unit** — the enabling change for the Aggregator/Coordinator decoupling. Backfill an `/aggregators/{aggregator_id}` group model where a human is a *member* rather than *being* the aggregator.
4. **Retire the shared network-service `x-api-key`.** Replace with **per-service KC clients (client-credentials) + token exchange** for on-behalf-of. Kills the client-set `user_id` bypass.
5. **Introduce OPA as the PDP.** Move per-route `if` authz into OPA policies over the §7 inputs; keep OAuth2 scope admission as the coarse pre-check.
6. **Item-level ownership + item/action discoverability/actionability/consent** become explicit columns/flags the OPA policy reads (some exist as JSONB state today; formalize).
7. **Peer-instance trust** migrates from HMAC `x-instance-token` to a **KC network-registry client + `network:federate`** validated locally via JWKS.
8. **signals-search** stops trusting the DB/caller: validate the same bearer token and ask OPA (discoverability ∧ consent), never return PII.

Phasing follows the existing Keycloak migration design's A–E cutover; OPA and the decoupled Aggregator group model slot into that sequence.

---

## 9. Keycloak + OPA modeling summary

**Realms.** One **shared** realm per **instance** (`bluedots`) holding **both** aggregator + signals clients (accounts, `sub`; one `sub` per human across both DPGs — see §2 realm-topology decision). One **network-registry realm** (instances-as-clients, `network:federate`, network operator roles).

**Clients (per instance realm):** `signals-ui` (public), `signals-api` (bearer + BFF), `aggregator-portal` (confidential), `aggregator-api` (service account), `search-api` (bearer), `notification-service` (service account), external clients `raya` / `campaign` / per-integrator, ai-diffusion clients.

**Realm roles (human):** `network_admin`, `org_owner`, `org_admin` *(future)*, `coordinator`, aggregator member roles *(future)*, `guardian` *(future)*, `network_facilitator` (registry realm).

**Groups:** `/orgs/{org_id}` (org membership + role), `/aggregators/{aggregator_id}` (**the decoupling** — humans are members; the aggregator-unit id is the group), `/participants`.

**Scopes (granted per client, admitted coarsely at the resource server):**
```
Signals:    participant:onboard  item:read  item:write:on_behalf  action:perform:on_behalf
            user:read  pii:read(→audit)  network:federate
Aggregator: org:read  coordinator:read  participant:read  export:request
Search:     search:query  search:read:non_pii
Notify:     notify:send
```

**Token claims:** `sub`, `roles[]`, `acting_org` (**aggregator-unit id from group**, replaces `x-acting-org-id`), `participant_role`, `user_status`, delegation claims (`azp` service + `on_behalf_of`).

**OPA (PDP):** policies keyed on scope ∧ item-level ownership ∧ discoverability/actionability ∧ consent/terms ∧ delegation validity. Resource facts passed as query input by the calling service. Coarse scope admission stays at the resource server (hybrid).

---

## 10. Open questions / provisional

- **(open) OPA deployment shape** — sidecar per service vs central PDP; how resource facts reach OPA (input doc vs bundle/data pull) for live consent/ownership state.
- **(open) Network Admin vs Network Facilitator** boundary once a real registry exists (S1 collapses them; S2+ separates).
- **(open) Voice phone-auth confidence** — does a caller's phone number sufficiently prove identity for on-behalf-of (Raya, ai-diffusion voice)? Shared with the consent design.
- **(open) Account-level operations** when a user's items are multi-owned (who may deactivate the whole account vs individual items).
- **(provisional) PID** — remains deferred; revisit only if a use case demands person-level cross-instance correlation.
- **(planned) Service registration/rotation** — how external clients request/receive/rotate scoped credentials; network-admin approval flow.
- **(future) Guardian/Proxy and Org-Admin/Aggregator-Admin tiers** — role values defined here; capability matrices to be filled when scheduled.

---

## Relationship to other IAM docs

- **`2026-06-29-iam-architecture-fork-centralized-vs-federated.md`** — this register adopts **B1** and further resolves that the network layer is a **KC registry (no mandatory PID)**.
- **`2026-07-08-multi-instance-iam-design.technical.md`** — to be updated to reference this register as the canonical actor source; its capability tables become views onto §6.
- **`2026-06-25-keycloak-migration-design.md`** — §8 rework list here refines its cutover; the Aggregator/Coordinator decoupling + OPA are new.
- **Consent designs** — consent/terms are §7 OPA inputs, gating items and actions at initiate and accept, bidirectionally.
