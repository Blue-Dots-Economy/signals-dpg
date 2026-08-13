# Multi-Instance IAM, Access Control & Consent — Design

**Audience:** Technical architect and tech leads who need to understand how identity, authorisation, cross-instance trust, external-service access, and consent fit together across **Signals-DPG**, **aggregator-dpg**, and **signals-search** once the network runs as multiple instances.

> **Status:** Provisional. The one upstream decision — **centralized `sub` vs federated NF/PID** — is settled here to **B1 (instance-local IdP + thin central Network Facilitator)** as the working assumption, per `2026-06-29-iam-architecture-fork-centralized-vs-federated.md`. Sections that hinge on unconfirmed product answers are marked (provisional); unbuilt work is marked (planned).

---

## Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design](#4-design)
5. [Data Model](#5-data-model)
6. [API Spec](#6-api-spec)
7. [Summary](#7-summary)

---

## 1. Introduction

This document describes the **identity and access layer for a multi-instance network** and how three services and the external agents consume it.

**Domain terms** (used precisely throughout):

- **network** — a shared contract (`blue_dot`, `purple_dot`). Its participants interoperate.
- **instance** — one deployment serving one network's domain(s). Two instances of `blue_dot` (`up-blue`, `ka-blue`) are separate deployments with **separate databases**.
- **domain** — a role inside a network: **seeker** / **provider**. *(Not a DNS name — the IAM/data-handling gdoc uses "domain" for the DNS host `seeker.bluedots.in`; that is a subdomain, not this.)*
- **item** — a versioned, schema-typed record (`profile_1.0`). An account may hold several.
- **account** — a login identity at **one instance** (phone/email → credentials).
- **org** / **coordinator** — the aggregator hierarchy (aggregator-dpg #462): a parent **org** registers once; **coordinators** register under it and onboard participants. "aggregator" = a coordinator's DB identity.
- **participant** — the onboarded seeker/provider (a Signals `user` + item).
- **NF (Network Facilitator)** — a thin central service that issues the **network-wide participant identifier (PID)**, maps PID → instance, holds **consent flags** (not raw consent), and brokers cross-instance PII exchange.
- **PID** — the opaque, network-wide participant id minted by the NF. The cross-instance join key.
- **sub** — a Keycloak subject id: the identity key **within one instance's realm**.

**What this design covers:** the identity model under multi-instance (§4.1–4.3); how the aggregator org/coordinator hierarchy maps onto it (§4.4); how **external services authenticate and are authorised (RBAC) over data and actions across Aggregator + Signals + Search** (§4.5); consent once Keycloak lands (§4.6); and cross-instance trust + PII exchange (§4.7). It does **not** re-specify the intra-instance Keycloak migration mechanics (see `2026-06-25-keycloak-migration-design.md`) or the consent ledger internals (see `2026-06-25-consent-management-design.md`); it states how both change under B1.

---

## 2. Background & Problem Statement

### Background

Where things stand today (concrete, per service):

- **Signals-DPG** authenticates via **better-auth** (local UUID identity) with two paths: `x-api-key` (integrating DPGs) and session (UI). Inter-instance reads exist (`/api/v1/network/item/fetch`, count-first + slice) but **inter-instance calls are unauthenticated** — trust holds only within one instance. Service traffic uses **one shared "network-service" API key**.
- **aggregator-dpg** already runs on **Keycloak** (realm `aggregator`, attribute-based authz, `x-acting-org-id`). PR **#462 (merged)** added the **org → coordinator hierarchy** behind `ORG_HIERARCHY_ENABLED`: an `aggregator_orgs` table (system of record) + `aggregators.parent_org_id` FK; org owner registers → **network admin** approves → coordinators register → **org owner** approves; KC group per org is an **authz mirror**, DB is the single authority. Type (seeker/provider) lives on the coordinator, not the org.
- **signals-search** is a read-side service over the shared `dpg` DB (vector + geo). It has no identity model of its own; it trusts whoever queries it.
- **External agents** (Raya voice bot, email/campaign — issue **#237**) authenticate with the **shared service key**; a caller can change `user_id` in the request and read another user's data. Campaign flows (bulk-upload → sync → PII attach → Raya/email) have no per-caller authorisation, no PII audit, and no defined export mechanism.
- **Product's identity answers** (`2026-06-25-iam-auth-open-questions-for-product.md`): registration is **per instance**; same phone = a separate account per instance; **no dedup**; a network-wide identifier is owned by a **Network Facilitator's own SSO**; a person may hold **multiple profiles** under one account and be **both** seeker and provider.

### Problem Statement

**Problem 1 — Identity is per-instance, but the network must behave as one.**
*Core challenge:* reconcile "each instance owns its accounts, no dedup" with "a user registered on any instance is discoverable network-wide."
Per-instance `sub`s cannot join across instances. Something network-wide must exist to correlate a participant across instances without centralising their accounts or PII.

**Problem 2 — Cross-instance calls are unauthenticated.**
*Core challenge:* let instance B trust a request that originated at instance A, and let a participant's identity be recognised at B.
Today B cannot verify A's caller or the participant's identity; the federated read path runs open.

**Problem 3 — External services have no real authN/authZ.**
*Core challenge:* a shared key with a client-supplied `user_id` is an authorisation bypass.
Raya/email/campaign (and future aggregator/search consumers) must authenticate as *themselves* and be constrained by **RBAC over the data and actions** they may touch across all three services — not a blanket key.

**Problem 4 — Delegated authority spans services and roles with different capabilities.**
*Core challenge:* aggregators, coordinators, and voice bots act *on behalf of* participants with **different limits**.
An aggregator/coordinator has full CRUD on **profiles it owns** (profile-level, not account-level ownership) with **PII reads gated + audit-logged**; a voice bot may **perform actions** and act on items **it does not own**, but must **tag every item/action with the acting service**. These distinctions aren't modelled.

**Problem 5 — Consent depends on an identity anchor that is changing.**
*Core challenge:* the consent design keys on a single global `sub` and one central consent DB; the identity model is now federated.
Consent must re-key to the network-wide identifier, keep **raw consent + PII at the instance**, gate **both initiate and accept** of an action, and gate **discovery bidirectionally**.

**Problem 6 — PII must move between instances on connect without a central PII store.**
*Core challenge:* on a mutual accept across instances, both parties must exchange contact PII under consent, audited, without PII passing through any central service.

> **Note on scope:** the multi-network-on-one-instance case (blue + purple co-tenant) is **out of scope** (product: "highly unlikely"; IAM gdoc S3 "out of scope"). The live near-term topology is **single network, single instance (S1)**; multi-instance (S2/S4) is the target this design must not preclude.

---

## 3. Key Design Problems

Restated as design targets, with the chosen direction:

- **P1 Identity** → **B1: instance-local Keycloak realm + a thin central NF** that mints the PID and maps PID → instance. Accounts and PII stay at the instance; only correlation data is central.
- **P2 Cross-instance trust** → realm/NF-issued tokens validated **locally** at the peer (shared JWKS / NF public key); a `network:federate` capability gates federation.
- **P3 External-service access** → **per-service Keycloak clients** (client-credentials) with **least-privilege scopes enforced uniformly across Signals, Aggregator, and Search**; the shared network key is retired.
- **P4 Delegated authority** → a **capability matrix** per principal type + a truthful **actor triple** (`performed_by` / `on_behalf_of` / `acting_org`) recorded on account/profile/action mutations; voice-bot per-action tagging.
- **P5 Consent** → re-key to **PID-flag-central + instance-raw**; initiate **and** accept gates; bidirectional discovery gating.
- **P6 Cross-instance PII** → **NF-brokered, field-scoped, time-bound, single-use connect tokens**; PII flows instance→instance directly.

---

## 4. Design

### 4.1 Identity model — instance-local IdP, thin central NF (B1)

**Decision.** Each **instance** runs its **own Keycloak realm** as the authority for its accounts (`sub` local to that instance). A single, thin **Network Facilitator (NF)** service issues a network-wide **PID** per participant and maintains **PID → instance** routing plus a **consent-flag registry**. The NF holds **no PII and no raw consent** — only correlation and flags.

**Why.** Product is explicit that registration is per-instance, operators host their own copy, and there is no dedup (open-questions §1.1/1.4/9.3). A single network realm (Option A) contradicts that and centralises data operators want to own. B1 keeps **data sovereignty at the instance** (the DPDP posture) while giving the network the one thing it needs to act as a whole: a shared, PII-free correlation id.

```
        ┌──────────────────────── network: blue_dot ─────────────────────────┐
        │                                                                     │
  ┌─────┴─────  instance: up-blue ──────┐        ┌────── instance: ka-blue ───┴─────┐
  │  Keycloak realm (up-blue)           │        │  Keycloak realm (ka-blue)         │
  │  accounts + sub + PII + raw consent │        │  accounts + sub + PII + raw consent│
  │  Signals API · Search · Aggregator  │        │  Signals API · Search · Aggregator │
  └───────────────┬─────────────────────┘        └───────────────┬───────────────────┘
                  │  register → get PID          resolve PID→inst │
                  ▼                                               ▼
        ┌───────────────────────── Network Facilitator (NF) ─────────────────────────┐
        │  PID registry (PID · home instance · actor type · active flag)              │
        │  routing index (PID → instance endpoint)                                    │
        │  consent-flag registry (network/discoverability/connect flags per PID)      │
        │  connect-token authority (field-scoped, time-bound, single-use)             │
        │  ── holds NO PII, NO raw consent, NO profile data ──                        │
        └────────────────────────────────────────────────────────────────────────────┘
```

> **Note on B1 vs B2:** B2 (make Keycloak *itself* the network realm and label it the NF) is operationally simpler but re-introduces a single network identity store — contradicting "operators host their own copy". B1 is chosen; the NF is a **new, thin service** (or a capability of an existing central service, e.g. the consent service). Whether the NF is **product/EkStep-owned** (Beckn-registry-shaped) or **built here** is a (provisional) confirmation (§4.x).

### 4.2 Realm topology & the two identity keys

Within an instance, the realm carries the same client/group/claim shape as the merged design (`keycloak-migration-design.md` §3): `signals-ui`, `signals-api`, `aggregator-portal`, `aggregator-api`, `search-api`, per-service external clients, `consent-service`. **`sub` is the intra-instance key**; **PID is the inter-instance key.**

- **Provisioning** issues the local `sub` and calls the NF to **mint/attach a PID**, storing the `sub ↔ PID` mapping in a local projection (§5). Same phone at another instance = a **new account, new `sub`, and a distinct PID** (no dedup — §9.3).
- **Discovery** (network-wide) resolves through the NF routing index (PID → instance), never by dereferencing another instance's `sub`.
- **Authz stays attribute/claim-derived** at each service — never client input (unchanged principle from both existing designs).

### 4.3 The deployment matrix (what each topology needs)

Using Signals vocabulary (translating the IAM gdoc's scenarios):

| Topology | Meaning | Identity | Cross-instance need |
|---|---|---|---|
| **S1** single network, single instance | seeker+provider, one deployment | local realm only; PID optional-but-issued | none (all local) — **the live near-term case** |
| **S2** single network, multiple instances | e.g. per-state or seeker/provider on separate deployments | local realms + NF PID | discovery + (planned) action via NF |
| **S4** single network, different domains, different operators | fully federated | local realms + NF PID + domain keypairs | full federation via NF |

**Why phase it this way.** S1 needs none of the NF machinery at runtime — so we **build instance-local Keycloak + consent now and issue PIDs from day one** (even in S1), keeping the NF seam a stub. That ships auth+consent without federation, and — crucially — **keying consent and cross-instance data on PID from the start means the later cut to S2/S4 is not another rekey** (§4.6).

### 4.4 Aggregator org/coordinator hierarchy on the identity model

The #462 hierarchy maps cleanly onto B1 (it already treats the DB as the single authority and KC as an authz mirror):

```
network admin ── approves ──▶ ORG (aggregator_orgs, system of record)
                                 │  owner: KC user, org_owner role (console deferred)
                                 │  KC group = authz mirror (no business state)
                                 ▼  approves
                              COORDINATOR (aggregators row = KC user, coordinator role)
                                 │  own signalstack org; type seeker|provider on the coordinator
                                 ▼  onboards
                              PARTICIPANT (Signals user + item; user.onboarded_by_org_id)
```

Design decisions this pins down (from #462 v2 + the RBAC gdoc):

- **Roles:** `network_admin` (approves org owners; per open-questions §10.1 *also receives complaint email* — **note the conflict**: the RBAC gdoc gives the network admin **form/schema template ownership**; resolve which, §4.x), `org_owner` (one per org, approves coordinators, transfer/offboard → planned), `org_admin` (multiple, Phase 2 — RBAC gdoc), `coordinator` (ground operator, may belong to **multiple orgs**).
- **Ownership is profile-level, not account-level** (§4.4 open-questions): an account may hold multiple profiles, each tagged to a possibly-different coordinator/org. Account-level authority when profiles are multi-owned is (provisional).
- **Offboarding** (open-questions §10.3): a coordinator's participants/items reassign **up to the org owner → down to another coordinator**; never orphaned.
- **Operational hierarchies** (RBAC gdoc §6) differ per network: **blue_dot** = Mandal-head/District pre-load (the "org" is a Mandal admin); **purple_dot** = pre-loaded org-name list. Both are the same org→coordinator shape with different registration field sets — driven by network config, not code.

### 4.5 External-service authentication & RBAC across Aggregator + Signals + Search

This is the crux of the multi-service ask. **Every external service becomes a first-class, per-service Keycloak client** (client-credentials), authorised by **least-privilege scopes enforced identically at all three services**. The shared network key is retired.

**4.5.1 Two capability profiles (from open-questions §3.4 / §8).**

| Principal | May do | Scoped to | Extra rule |
|---|---|---|---|
| **Aggregator / coordinator** | item CRUD, account Create+Read (Update/Delete provisional) | **items it owns** (profile-level) | PII read = **gated + audit-logged** |
| **Voice bot / campaign agent** | item CRU + **perform actions** | **may act on items it does NOT own** | **must tag every item/action** with the acting service (bot-1 created, bot-2 applied) |

**4.5.2 Scope catalogue** (granted per client, enforced per route across the three services):

```
Signals:   participant:onboard  item:read  item:write:on_behalf  action:perform:on_behalf
           user:read            pii:read (→ forces audit)        network:federate
Aggregator: org:read  coordinator:read  participant:read  export:request
Search:    search:query  search:read:non_pii
```

- **RBAC is the intersection of (client scopes) ∧ (per-object ownership) ∧ (consent state).** A `search:query` client sees only non-PII, discoverable items; `pii:read` requires an audit row *and* a consent flag; `item:write:on_behalf` requires naming the target PID and records the actor triple.
- **Search** stops trusting its caller: it validates the same bearer token, and filters results to what the caller's scopes + the item's discoverability/consent flags allow — no PII in search responses (matches IAM gdoc NRT-2/RT-3).

**4.5.3 The #237 campaign / Raya-email flow, done under this model.**
Product's near-term answer authorises the prototype by **individual user (network admin / org owner / coordinator)**, moving to service-level "after it becomes a DPG." The identity fork (§4.1) says **user-scoped access across the network *is* the IAM problem** — a common API key with a client-set `user_id` is exactly the bypass in Problem 3. So:

- **Interim (S1, prototype):** the prototype authenticates as the **acting user** (their token), and Signals authorises the export to **only the profiles that user may see** (coordinator → own; org owner → org's, carrying the seeker/provider `domain` in the payload; network admin → per §10.1 scope). No caller-supplied `user_id` trust.
- **Data export is async/batch** (not inline — API size limits): request → **worker snapshots** → **blob storage** → **pre-signed URL emailed** to the requester. Sync returns **new + updated since last sync** (a per-(caller, dataset) watermark), paginated (product: **300/page**; multi-file for large sets — open item in #237).
- **PII attach is server-side at Signals**, never exposed to the external service's own store: payload comes back **PID-only / non-PII**, Signals attaches PII and forwards to Raya/email. Three request classes (non-PII analysis, non-PII Raya dataset, non-PII interview prep); **PII/full dataset only for those declared purposes**.
- **Every PII request is audit-logged** (who, what, when, why; retention where applicable) — the request payload **mandates** these fields.
- **Raya config lives in Signals** (`agent_id`, payload mapping, which agent to trigger when); email egress is a **pre-signed URL**, recipients restricted to network admin / org owner / coordinator.

> **Note (planned):** when campaign management becomes its own DPG (#237 future scope), the prototype's user-scoped access is replaced by a **service client** with the voice-bot capability profile (§4.5.1) — the same seam, no data-model change. Confirm with product whether to **adopt service-level now** for DPDP rather than user-token interim.

### 4.6 Consent once Keycloak lands

The consent design (`2026-06-25-consent-management-design.md`) is a **hard dependent** of this work ("both DPGs converge onto Keycloak; the consent service is built against the identity key"). Under B1 it changes in three ways:

1. **Re-key from global `sub` to PID + instance.** Raw consent text + the versioned ledger stay **at the instance** (keyed on local `sub`/account); only **consent flags** (network-participation, discoverability, connect, category, outbound) live **centrally at the NF, keyed on PID**. This preserves data sovereignty and still lets match/discovery honour consent network-wide.
2. **Gate initiate *and* accept.** Consent issue #99 statement 4 requires consent **when a connect/apply is initiated**; the current design gates **accept only**. Add the initiate-time gate. (Statements 1–5 give the exact copy for signup/login, profile-create, initiate, accept.)
3. **Bidirectional discovery gating** (open-questions §7.3): a non-consented user is **hidden from discovery and un-actionable by counterparties**, not just blocked from their own writes.

Login is **not** consent-gated the same way: login needs a verified channel (cannot degrade to "unverified"), while consent can (guardian/proxy/voice OTP). Both share notification-service and the per-instance provider flag (keycloak design §5).

### 4.7 Cross-instance trust & PII exchange

- **Trust:** a peer validates a realm/NF-issued token **locally** (issuer + JWKS / NF public key) carrying `network:federate`; no call back to the issuer. Closes the currently-unauthenticated inter-instance gap (Problem 2).
- **Connect PII exchange (Problem 6):** on a mutual accept across instances, the NF issues **two field-scoped, time-bound (15–30 min), single-use** tokens — one per party. Each party redeems **directly at the other's home instance** (resolved via the routing index); the instance validates against the NF public key and returns **only the scoped fields**. **PII never passes through the NF.** Every issuance/redemption is audit-logged at the NF (PIDs, connection id, fields, ts) — the DPDP evidence trail. (This is the IAM gdoc NRT-1 mechanism, adopted.)

### 4.8 End-to-end flows — register, discover, action

The three flows below show how the two keys behave: **`sub` and PII stay at the home instance; only the PID (and, for connect, a short-lived scoped token) cross a boundary.** The NF is a correlator + broker, never a data store.

**(1) Register — local account + network PID.**

```
Participant                up-blue                          NF (central)
   │  sign up (phone OTP)     │                                 │
   ├────────────────────────▶ │                                 │
   │                          │ Keycloak mints sub_A (local)    │
   │                          │ store account + PII + raw T&C   │
   │                          │ POST /nf/participant (no PII)   │
   │                          ├────────────────────────────────▶│ mint PID_1
   │                          │           { pid: PID_1 }         │ home=up-blue
   │                          │◀────────────────────────────────┤ flags = off
   │                          │ identity_projection: sub_A↔PID_1 │
   │◀───────────────────────── │ registered                      │
        accept T&C ⇒ NF network + discoverability flags flip ON
```

**(2) Discover — seeker on `up-blue` finds a provider on `ka-blue` (non-PII only).**

```
Seeker(up-blue)      up-blue          NF (routing + flags)          ka-blue
   │ search           │                     │                         │
   ├─────────────────▶│ local hits +        │                         │
   │                  ├── route + discoverable PIDs ──▶│ match PIDs,   │
   │                  │                      │          │ home + flags? │
   │                  │◀── PID_9 @ ka-blue ──┤ (discoverability ✔)     │
   │                  ├── fetch NON-PII item(PID_9) ───────────────────▶│
   │                  │◀── skills/role/location (no name/phone) ────────┤
   │◀── merged non-PII results ──                                       │
        PID is the join key; sub_A / sub_9 never cross instances
```

**(3) Action — connect across instances → mutual accept → direct PII exchange.**

```
Seeker(up-blue) up-blue        NF (consent + connect-token authority)      ka-blue  Provider(ka-blue)
   │ connect PID_9  │                       │                                 │
   │ (+initiate     │ emit connect(PID_1→PID_9)                              │
   │  consent #4)   ├──────────────────────▶│ record req (PIDs, no PII)      │
   │                │                       ├── notify target ───────────────▶│ "wants to connect"
   │                │                       │◀── accept (+accept consent #5) ─┤
   │                │      NF checks BOTH sides: network ∧ connect flags      │
   │                │      ✔ satisfied → issue 2 field-scoped tokens          │
   │                │◀─ token_A(name,phone; 15m; 1-use) ─┐                    │
   │                │                       ├─ token_B ──┼───────────────────▶│
   │                │ redeem token_A ───────┼───────────▶│ validate vs NF key (local)
   │                │◀── PROVIDER PII ──────┼─ direct;   │ return scoped PII once
   │                │                       │  NOT via NF │◀ redeem token_B → SEEKER PII
   │◀ provider contact                      │            │       seeker contact ▶│
     every issue/redeem audit-logged at NF (PIDs, fields, ts) = DPDP trail
     any consent flag missing ⇒ NF issues no token ⇒ notify "pending consent", no PII
```

**Invariants the flows encode:** (a) `sub` + PII never leave the home instance — only the PID travels, plus a short-lived scoped token at connect; (b) the NF holds routing + consent *flags* + issues tokens, but never sees PII or raw consent; (c) consent gates at three points — participate/discoverable (register, §4.6), initiate (connect sent, #99 statement 4), accept (PII released) — and PII moves **instance→instance directly**, audited (§4.7).

### 4.x Open questions / provisional premises

- **(provisional) NF ownership & shape** — product/EkStep-owned (Beckn registry) vs built here (§4.1). Determines whether we build or integrate the PID registry.
- **(provisional) Cross-instance *action*** (not just discovery) required near-term? (open-questions §6.1). If discovery-only first, defer the §4.7 connect-token machinery.
- **(open) Network-admin scope conflict** — approves-orgs-only (§10.1) vs owns form/schema templates (RBAC gdoc). Blocks the role×action matrix.
- **(open) Account-vs-profile ownership** — account-level CRD when profiles are multi-owned; max profiles per account (§4.4).
- **(open) Post-accept PII window** — persistent or revocable, and for how long (§5.1) — the §4.7 token lifetime answers the exchange, not an ongoing view.
- **(planned) Service registration/rotation interface** — how external services request/receive/rotate scoped creds (open-questions §8.2); none exists today.
- **(open, #237)** single vs multi-file export for large sets; async sync latency SLA.

---

## 5. Data Model

All columns snake_case. New/changed tables only; existing Signals/aggregator tables referenced by name.

### `nf_participant` — Network Facilitator registry (central; PII-free)

| Column | Type | Description |
|---|---|---|
| `pid` | uuid PK | the **network-wide participant id** |
| `home_instance` | text NOT NULL | instance that owns the account/PII |
| `actor_type` | text | _seeker / provider / both_ |
| `active` | bool NOT NULL | network-wide activation; delete/erasure flips this + propagates |
| `created_at` | timestamptz | |

### `nf_consent_flag` — central consent flags (central; no raw text)

| Column | Type | Description |
|---|---|---|
| `pid` | uuid FK → `nf_participant` | |
| `flag` | text | _network / discoverability / connect / category / outbound_ |
| `granted` | bool NOT NULL | |
| `updated_at` | timestamptz | _raw consent + version live at the instance, not here_ |

Index `(pid, flag)`. **Invariant:** the NF holds flags only; the authoritative ledger is per-instance.

### `identity_projection` — per-instance (Signals) `sub ↔ pid` map

| Column | Type | Description |
|---|---|---|
| `sub` | text PK | local Keycloak subject |
| `pid` | uuid | **network id**; the join key for federation & consent |
| `participant_role` | text | seeker / provider / both |
| `user_status` | text | drives status-gating |
| `legacy_user_id` | uuid | _traceability during migration_ |

### `pii_access_log` — audit for every gated PII read

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `actor` | text | service/coordinator client id or `sub` (**performed_by**) |
| `subject_pid` | uuid | whose PII |
| `fields` | text[] | which fields returned |
| `reason` | text NOT NULL | **why** (mandated in request) |
| `purpose` | text | _analysis / raya_dataset / interview / connect_ (#237 classes) |
| `at` | timestamptz NOT NULL | |

### `service_client` — external-service registration (per-service creds)

| Column | Type | Description |
|---|---|---|
| `client_id` | text PK | Keycloak client |
| `display_name` | text | |
| `capability_profile` | text | _aggregator / voice_bot_ (§4.5.1) |
| `scopes` | text[] | granted least-privilege scopes |
| `status` | text | pending / active / revoked _(atomic CAS on approve)_ |

### Item/action actor tagging (extends existing Signals tables)

On `items` and `item_actions`: `performed_by` (service/client), `on_behalf_of` (participant PID/sub), `acting_org` (org_id claim). **Voice-bot writes MUST populate all three**; `x-acting-org-id` is retired (token-derived).

### Aggregator (already shipped, #462) — referenced

`aggregator_orgs` (system of record) + `aggregators.parent_org_id` FK; org status via atomic CAS; slug partial-unique over non-terminal rows.

### `export_job` — async data export (#237)

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `requested_by` | text | acting user/client |
| `scope` | jsonb | domain, pid set / cohort, field set, PII-flag |
| `watermark` | timestamptz | _last-synced marker → returns new+updated since_ |
| `blob_url` | text | pre-signed download (expiring) |
| `status` | text | queued / running / ready / expired |

---

## 6. API Spec

### NF (central) endpoints

#### `POST /nf/v1/participant` — mint/attach a PID at provisioning
Request:
```jsonc
{ "home_instance": "up-blue", "actor_type": "seeker" }   // no PII
```
Responses: `201 { "pid": "…" }`, `4xx { error, message }`.

#### `GET /nf/v1/route/:pid` — resolve PID → instance endpoint
Responses: `200 { "instance": "ka-blue", "endpoint": "https://…" }`, `404`.

#### `POST /nf/v1/connect-token` — issue field-scoped bidirectional PII tokens (on mutual accept)
Request:
```jsonc
{ "a_pid": "…", "b_pid": "…", "fields": ["name","phone"], "connection_id": "…" }
```
Responses: `200 { "token_a": "…", "token_b": "…", "expires_in": 900 }` — **only if all consent flags satisfied for both**; else `409 { error: "CONSENT_INCOMPLETE" }`. NF audit-logs issuance.
Validation: both PIDs active; network+connect flags true both sides; single-use.

### Signals endpoints (bearer, scope-gated)

#### `POST /api/v1/pii/read` — gated PII read (aggregator/voice)
Request:
```jsonc
{ "subject_pid": "…", "fields": ["phone"], "reason": "connect follow-up", "purpose": "connect" }
```
Responses: `200 { …fields }` **and writes `pii_access_log`**; `403 PII_CONSENT_MISSING`.
Validation: caller has `pii:read`; consent flag present; `reason` + `purpose` mandatory.

#### `POST /api/v1/export/request` — async export (#237)
Request:
```jsonc
{ "scope": { "domain": "seeker", "pii": false, "fields": ["skills","location"] } }
```
Responses: `202 { "job_id": "…" }`; worker → blob → **pre-signed URL emailed**. Sync returns **new+updated since `watermark`**, paginated (300).
Validation: caller authorised for exactly the profiles in scope (no client-supplied `user_id` trust); PII scope requires `pii:read` + audit.

#### cross-instance redeem `POST /api/v1/connect/redeem`
Request: `{ "token": "<nf-issued>" }` → validates against NF public key locally → returns scoped PII once; marks redeemed.

### Search endpoints

#### `POST /v1/search` — now scope-gated
Same bearer; returns **non-PII, discoverable, consented** items only; enforces field classification centrally-defined, instance-enforced.

### Admin / service-registration endpoints (planned)

#### `POST /admin/v1/service-client` — register an external service
Request: `{ "display_name": "raya", "capability_profile": "voice_bot", "scopes": [...] }` → network-admin approve (atomic CAS) → client-credentials issued; rotation/revoke per client.

---

## 7. Summary

**What changes.** Identity becomes **instance-local Keycloak + a thin central NF** that issues a **PID** (the PII-free network join key). Every service — Signals, Aggregator, Search — validates the same tokens and enforces **least-privilege scopes ∧ ownership ∧ consent**; the shared network key and client-supplied `user_id` trust are retired. The #462 org/coordinator hierarchy sits on top unchanged in shape. Consent re-keys to **PID-flag-central + instance-raw**, gates **initiate and accept**, and gates discovery **bidirectionally**. Cross-instance PII moves via **NF-brokered, field-scoped, single-use tokens** — never through the centre. External campaign agents (#237) get **user-scoped access now → service-client later**, with **async pre-signed-URL export** and **mandatory PII audit**.

**Net effect.** Operators keep their data (sovereignty / DPDP); the network still acts as one (discovery, cross-instance connect); external services are authenticated and RBAC-bounded across all three services; consent is enforceable and auditable end-to-end.

**Phasing.**
1. **S1 now** — instance-local Keycloak + consent + per-service clients + PID issued (NF seam stubbed). Ships auth+consent without federation; **PID-keyed from day one** so S2/S4 is no rekey.
2. **S2/S4 (planned)** — NF routing + `network:federate` + connect-token PII exchange.
3. **External-service track** — registration/rotation interface; campaign DPG cutover.

**What remains open (blocks finalisation):** the NF **build-vs-integrate** decision; **network-admin scope** (approve-only vs schema-owner); **account-vs-profile** ownership rules; cross-instance **action** in-scope-or-not; and the #237 sync-latency/file-size specifics. These are enumerated in §4.x and the open-questions register (F1–F8).
