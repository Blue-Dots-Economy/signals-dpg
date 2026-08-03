# IAM & Auth — Pending Decisions & Resolution Design

**Audience:** System architect and engineers implementing the Signals-DPG auth/IAM rework. This doc
enumerates the decisions still open *after* the substrate was settled (B1, per the 2026-07-17 Actor &
Action Register), states the chosen/recommended resolution for each, and pins how each maps onto
**Keycloak (authN)** + **OPA (authZ)** and the data model. It is the decision-log companion to
`keycloak-migration-design.md` (§4 cutover) and the Actor & Action Register (§6 actor tables, §7 OPA
inputs). It does **not** re-derive the substrate — see those docs.

---

## Contents

1. [Introduction](#1-introduction)
2. [Background & Problem Statement](#2-background--problem-statement)
3. [Key Design Problems](#3-key-design-problems)
4. [Design (per-decision resolution)](#4-design-per-decision-resolution)
5. [Data Model implications](#5-data-model-implications)
6. [Decision register (status matrix)](#6-decision-register-status-matrix)
7. [Summary](#7-summary)

---

## 1. Introduction

The refactor-vs-rewrite question is answered (evolve in place — see
`2026-07-22-signals-refactor-vs-rewrite.md`), and the **identity substrate is settled**: instance-
local Keycloak realms as the account authority, a KC-based network registry (instances as clients),
**no mandatory per-participant PID**, and **Aggregator = operating unit** decoupled from the human
Coordinator logins. What remains is a bounded set of **policy decisions** — most of which are inputs
the **OPA policy** must evaluate — plus a handful of **engineering-owned mechanics** on the critical
path.

This document covers, for each open decision:

- The decision and why it blocks (which phase, which artifact)
- The recommended resolution, framed as **(lock)** simple-rule-now vs **(flex)** config-driven
- Its **KC + OPA modeling** consequence (claim / scope / group / policy input) and any **data-model** column

> **Note on provenance:** decisions D1–D8 reconcile the 2026-06-29 product Q&A register against the
> 2026-07-17 register's §10 open list. Premises P1/P4 (single global `sub`) are **rejected**; the
> per-instance model (B1) supersedes them. Engineering items E1–E5 are ours to settle.

---

## 2. Background & Problem Statement

### Background

The substrate (settled) fixes the *shape*: KC issues short-lived tokens carrying `sub`, roles,
`acting_org` (aggregator-unit group claim, replacing `x-acting-org-id`), and delegation claims
(`azp` + `on_behalf_of`); a resource server does **coarse OAuth2 scope admission** then calls **OPA**
for the business decision over `caller-scopes ∧ item/action-ownership ∧ discoverability/actionability
∧ consent/terms ∧ delegation-validity`. See Register §3, §9.

What the substrate does **not** fix is the *content* of those OPA inputs and several role/lifecycle
rules. Those gaps are what stall policy authoring and the credential-issuance mechanics.

### Problem Statement

**Problem 1 — Ownership granularity is per-item, account-level authority is undefined.** *Core
challenge:* ownership binds an aggregator to a participant's **item**, not the account; when a single
account's items are multi-owned, *who* may perform account-level CRUD is unspecified. OPA cannot
resolve account-scoped operations. (D1)

**Problem 2 — The Network Admin capability set self-contradicts.** *Core challenge:* two product
sources give a narrow (approve-orgs-only) vs. broad (owns schema/consent templates) Network Admin.
The realm role's scope set can't be finalized. (D2)

**Problem 3 — No enumerated role × action matrix.** *Core challenge:* roles exist; the gated-action
table (esp. `pii:read`, user management) does not. OPA role×action policies have no source of truth.
(D3)

**Problem 4 — Multi-role participant modeling & self-match.** *Core challenge:* seeker+provider on
one account — one dual-role item or two — and self-match exclusion, are undecided; affects the item
model and match filtering. (D4)

**Problem 5 — Cross-instance *action* scope & timing.** *Core challenge:* discovery is network-wide;
cross-instance *action* is `(planned)`. Whether it's near-term determines how much of the federation-
trust phase (Register §8.7, Class D) ships now. (D5)

**Problem 6 — PII exchange lifetime & voice-bot PII rule.** *Core challenge:* post-accept counterparty
PII view — persistent vs. time-bound single-use tokens (Register/IAM proposes 15–30 min) — and whether
the voice bot's PII access is audited like an aggregator, are open. Drives `pii:read` token issuance.
(D6)

**Problem 7 — On-behalf-of identity confidence for phone-auth channels.** *Core challenge:* is a
phone number sufficient proof for RFC-8693 delegation (Raya, ai-diffusion voice)? Gates the whole
Class C delegation model and OPA's delegation-validity input. (D7)

**Problem 8 — Account recovery & recycled-number policy.** *Core challenge:* phone-first identity with
no recovery/re-verification path. Safety gap, non-blocking. (D8)

> **Note on engineering-owned gaps (E1–E5):** OPA deployment topology, a service credential
> registration/rotation interface (none exists — only a shared static key today), the better-auth→KC
> data migration, item-lifecycle transition cascades, and initiate-time consent gating. Detailed in
> §4; they need no product input but sit on the critical path.

---

## 3. Key Design Problems

The build targets, in dependency order:

```
   BLOCK BUILD (OPA policy authoring)          NEEDED SOON            CAN WAIT
   ┌───────────────────────────────┐   ┌────────────────────┐   ┌──────────┐
   │ D1 account-vs-item authority   │   │ D4 dual-role/self-  │   │ D8       │
   │ D2 network-admin scope         │   │    match           │   │ recovery │
   │ D3 role × action matrix        │   │ D5 x-instance action│   │ +recycle │
   └───────────────────────────────┘   │ D6 PII window/voice │   └──────────┘
                │                       │ D7 phone-auth conf. │
                ▼                       └────────────────────┘
   E1 OPA topology · E2 cred issuance · E3 KC migration  (engineering, parallel)
   E4 lifecycle cascade · E5 initiate-consent
```

---

## 4. Design (per-decision resolution)

### 4.1 D1 — Account-vs-item ownership authority `(blocks Phase 1/2)`

**Decision:** Ownership stays **item-level** (Register §7). Introduce an explicit
**account-authority** rule: the **participant is the account principal**; an aggregator holds
indefinite CRUD on **items it onboarded** (`acting_org` match) but on the *account* only
**create-if-absent + read**. **No aggregator account update/delete.** Cap items/account at a
config constant (default 10).

*Why:* keeps the OPA ownership predicate a pure function of item→`acting_org`; avoids the undefined
"which of N item-owners controls the account" case by removing account-mutation from aggregators
entirely. **(lock)** — cheaper, and account-mutation is reversible to add later.

**KC + OPA:** OPA `account_op` policy = `subject.sub == account.sub` OR `role in {network_admin}`
(never aggregator). Scope `participant:onboard` grants create-if-absent only. Item CRUD unchanged
(`item:write:on_behalf` ∧ ownership).

```
account CRUD  ─▶ OPA: allow iff sub==owner  (aggregator: C-if-absent + R only)
item CRUD     ─▶ OPA: allow iff caller-scope ∧ item.acting_org==caller.unit
```

### 4.2 D2 — Network Admin scope `(blocks Phase 1)`

**Decision:** Network Admin = **org approval + schema/consent template authorship (`network.json`)
+ complaint routing**, and **zero PII access**. Reconciles QD-10.1 (narrow) with RBAC-§3 (owns
config): broad over *configuration*, null over *personal data*.

*Why:* config authorship must live somewhere with network scope; PII-blindness preserves the DPDP
posture (Register §7 PII audit). **(lock)**.

**KC + OPA:** realm role `network_admin`; scopes `org:approve`, `schema:publish`; **explicitly no**
`pii:read`. OPA denies any `pii:read` for `network_admin` regardless of other inputs.

### 4.3 D3 — Role × action capability matrix `(blocks Phase 1)`

**Decision:** Engineering drafts the full matrix from the RBAC doc; product confirms per row. Baseline
below; `pii:read` is always audit-forced (Register §7).

| Action \ Role | Participant(self) | Coordinator | Org Admin(F) | Org Owner | Network Admin |
|---|---|---|---|---|---|
| item CRUD (owned) | ✓ own | ✓ unit | ✓ unit | ✓ org | ✗ |
| `pii:read` (→audit) | ✓ own | ✓ gated | ✗ | ✗ | ✗ |
| manage users | ✗ | ✗ | ✓ (subset) | ✓ | ✗ |
| approve orgs | ✗ | ✗ | ✗ | ✗ | ✓ |
| publish schema/consent | ✗ | ✗ | ✗ | ✗ | ✓ |

*Why:* OPA role×action rules compile directly from this. **(lock** per row once confirmed**)**.

**KC + OPA:** realm roles `coordinator`/`org_admin`/`org_owner`/`network_admin`; groups
`/orgs/{id}`, `/aggregators/{id}`. OPA policy keyed on `role × verb × ownership`.

### 4.4 D4 — Dual-role participant & self-match `(needed soon)`

**Decision:** Model seeker+provider as **two items** under one account (not one dual-role item);
matching **excludes items sharing an owning account**.

*Why:* two items keep the per-item ownership/discoverability/consent flags clean (each side has its
own lifecycle); a dual-role item would need per-field side-tagging. Self-match exclusion is a cheap
predicate on `account.sub`. **(lock)**.

**Data/OPA:** no schema change (items already per-role). Match filter: `candidate.account_sub !=
querent.account_sub`.

### 4.5 D5 — Cross-instance action scope `(needed soon)`

**Decision:** **Discovery-first.** Ship network-wide discovery (exists — count-first+slice) hardened
with peer auth; treat cross-instance *action* as a fast-follow behind the same KC-network-registry
trust. **Harden the cross-instance action path's peer auth to parity with the fetch path as a Phase-3
priority in its own right**, independent of whether cross-instance *action* is in near-term scope.

*Why:* cross-instance connect needs the NF-issued, field-scoped, time-bound PII exchange (Register
NRT-1) which depends on D6; discovery doesn't. Decouple. **(lock** scope; the *auth* fix ships now**)**.

**KC + OPA:** peer = KC network-registry client + scope `network:federate`, validated locally via
JWKS (Register §8.7). Applies to both `*_local` fetch **and** the action target route.

### 4.6 D6 — Post-accept PII window & voice-bot PII rule `(needed soon)`

**Decision:** Counterparty PII exchange is **persistent for the connection's life but revocable on
consent withdrawal** (relationship view, not a 15–30 min single-use token) for the *in-network*
case; the **short-lived single-use token** (NRT-1) is reserved for the *cross-instance* exchange
(instance→instance, never via NF). Voice bot PII = **aggregator-equivalent: gated + audit-forced**,
never exempt.

*Why:* two different needs — an ongoing intra-instance relationship vs. a one-shot cross-instance
hand-off. Using single-use tokens for an ongoing relationship would churn re-issuance. **(flex** on
the window length via config; **lock** the voice-bot audit rule**)**.

**KC + OPA:** scope `pii:read` gated by OPA on `consent-active ∧ (accepted-connection ∨ ownership)`;
every grant writes a `pii_reveal_audit` row (already exists). Cross-instance issuance = NF/registry
token, single-redemption.

### 4.7 D7 — Phone-auth on-behalf-of confidence `(needed soon)`

**Decision:** OTP-verified phone = **sufficient confidence for that caller's own items/actions within
the handled session**; the bot may **not** act for arbitrary users; **mandatory actor tagging** on
every item/action (`performed_by` bot client + `on_behalf_of` participant). Register the campaign
prototype as **acting-user token now → service client with voice-bot profile later** (Register §6.C).

*Why:* bounds the delegation-validity OPA input to the authenticated caller; tagging makes every
assisted action auditable and reversible. **(lock)**.

**KC + OPA:** Class C clients `raya`/`campaign` with `action:perform:on_behalf`,
`item:write:on_behalf`; OPA `delegation_valid` = `on_behalf_of == session-verified-phone-subject`.

### 4.8 D8 — Account recovery & recycled numbers `(can wait)`

**Decision:** Phase 1 = **aggregator-assisted recovery + OTP re-verification**; dormant-account
re-verification on any number change; self-serve recovery `(planned)`.

*Why:* closes the lockout/takeover gap cheaply without building a full recovery UX now. **(flex)**.

### 4.9 Engineering-owned mechanics (E1–E5) `(no product input; critical path)`

- **E1 — OPA deployment topology `(open)`.** Sidecar-per-service vs. central PDP; how live resource
  facts (ownership, consent) reach OPA — query **input** doc (caller passes facts) vs. **bundle/data
  pull**. *Lean:* sidecar + input-doc for ownership/consent (freshness), central bundle for static
  role/scope policy. Resolve before Phase 1 OPA rollout.
- **E2 — Service credential issuance/rotation interface `(planned)`.** No interface exists — only a
  manually-shared network-service key. Design self-serve request → network-admin approve →
  client-credentials issue → rotate/revoke (Register §10 "service registration"). Blocks retiring the
  shared `x-api-key` (§8.4).
- **E3 — better-auth → KC migration `(provisional)`.** Existing text-UUID `user.id` referenced across
  ~61 route files + `items.created_by` etc. Map legacy id → KC `sub` via a translation column during
  cutover; no big-bang. Follows `keycloak-migration-design.md` §4.
- **E4 — Item lifecycle transitions & cascade `(open)`.** Define live→paused/draft transitions and
  the effect on in-flight actions (cancel/freeze/notify). Engineering to propose; ties consent-v1.
- **E5 — Initiate-time consent gate `(open)`.** Register §7 gates actionability/consent at **both**
  initiate and accept; the consent design currently captures at accept only. Add the initiate gate
  (consent-design change).

---

## 5. Data Model implications

Most decisions are policy over existing columns; the genuinely new/affected fields:

### `item` (existing — formalize flags as OPA inputs, Register §8.6)
| Column | Type | Description |
|---|---|---|
| `acting_org` | text | _owning **aggregator-unit** id — the item-level ownership key (D1)_ |
| `discoverability` | text/enum | _`(formalize)` per-item OPA input; today partly JSONB state_ |
| `actionability` | text/enum | _`(formalize)` gated at initiate **and** accept (E5)_ |

### `pii_reveal_audit` (exists — reused by D6/D7)
| Column | Type | Description |
|---|---|---|
| `actor_sub` | text | _`performed_by` — participant, coordinator, **or bot client** (D7 tagging)_ |
| `on_behalf_of` | text | _subject whose PII was revealed_ |
| `reason` | text | _required; every `pii:read` forces a row_ |

### `service_client` `(new — E2)`
| Column | Type | Description |
|---|---|---|
| `client_id` | text PK | _KC client id_ |
| `scopes` | text[] | _granted least-privilege scope set (aggregator vs voice-bot profile)_ |
| `approved_by` | text | _network-admin sub_ |
| `rotated_at` | timestamptz | _rotation/revocation tracking_ |

> **Note (provisional):** no new PID table — the substrate defers per-participant network identifiers.
> Cross-instance correlation stays `(planned, only if a use case forces it)`.

---

## 6. Decision register (status matrix)

| ID | Decision | Status | Blocks | Recommended stance | KC/OPA artifact |
|---|---|---|---|---|---|
| D1 | Account-vs-item authority | 🔴 open | Phase 1/2 | **(lock)** participant-owns-account | OPA `account_op`; `participant:onboard` |
| D2 | Network Admin scope | 🔴 open | Phase 1 | **(lock)** config-broad, PII-null | role `network_admin`; no `pii:read` |
| D3 | Role × action matrix | 🔴 open | Phase 1 | **(lock)** per-row confirm | OPA role×verb×ownership |
| D4 | Dual-role & self-match | 🟡 soon | discovery | **(lock)** two items | match filter on `account_sub` |
| D5 | Cross-instance action scope | 🟡 soon | Phase 3 | **(lock)** discovery-first | `network:federate` + JWKS |
| D6 | PII window / voice-bot rule | 🟡 soon | consent/PII | **(flex** window**)** | `pii:read` gate; NF token x-inst |
| D7 | Phone-auth on-behalf-of | 🟡 soon | Class C | **(lock)** OTP-in-session + tagging | `*:on_behalf`; `delegation_valid` |
| D8 | Recovery & recycled numbers | 🔵 wait | — | **(flex)** assisted first | KC recovery flow |
| E1 | OPA topology | 🟡 eng | Phase 1 OPA | sidecar+input / central bundle | — |
| E2 | Cred issuance/rotation | 🟡 eng | retire `x-api-key` | self-serve→approve→issue | `service_client` |
| E3 | better-auth→KC migration | 🟡 eng | Phase 1 | id→sub translation, no big-bang | migration §4 |
| E4 | Lifecycle cascade | 🟡 eng | Phase 2 | eng proposal | `actionability` |
| E5 | Initiate-time consent | 🟡 eng | Phase 2 | add initiate gate | OPA consent input |

---

## 7. Summary

The substrate is settled, so the residual work is **policy authoring**, not architecture. **D1, D2,
D3 are the hard blockers** — they are the direct source of truth for OPA's ownership, admin-scope, and
role×action policies; nothing meaningful in Phase 1 compiles without them. **D4–D7** are needed within
the first few phases and each has a low-risk **(lock)** default that lets build proceed while product
confirms. **D8** and the engineering items **E1–E5** are on the critical path but need no product
input — notably **E2** (a real credential-issuance interface) gates retiring the shared key, and
**bringing the cross-instance action path's peer auth to parity with the fetch path** should be
prioritized in Phase 3 in its own right, independent of D5's feature scope. Recommended next step:
take D1–D3 to product with the defaults above, and start E1/E3 in parallel.
