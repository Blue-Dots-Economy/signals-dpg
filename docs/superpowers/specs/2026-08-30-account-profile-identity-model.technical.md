# Account, Profile & Identity Design

**Audience:** Architects, backend leads and integration owners across Signals-DPG,
aggregator-dpg and the voice channel, who need to understand how an account, a profile
and a contact relate — and why the current collapse between them is producing
cross-tenant data exposure.

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

This document specifies the target model for identity on a Signals network: what an
account is, what a profile is, and what a "contact" means when the same phone number can
be a login credential, a delivery address and a disclosed detail all at once.

Domain terms used throughout:

- **Network** — a shared contract (`blue_dot`, `orange_dot`), defined by `network.json`.
- **Domain** — a role inside a network (`seeker`, `provider`, `practitioner`).
- **Network admin** — the entity hosting the network. Owns domain schemas and the
  interaction rules between them.
- **Profile** — a versioned, schema-typed record; the *dot on the map*. Discoverable,
  searchable, indexable.
- **Account** — the principal that authenticates. Today the `user` table; historically
  better-auth, now mirrored into Keycloak with `sub == user.id`.
- **Anchor** — the verified, unique identifier an account authenticates with.
- **Aggregator** — an organisation that onboards and manages participants in bulk.

The design covers: the account/profile boundary; the contact contract that replaces four
competing mappings; profile ownership and attribution; how the voice channel may act; and
PII at rest with a decryption-authority model.

It does **not** cover migration. The model is derived from requirements; the path to it is
planned per sub-project (§7).

---

## 2. Background & Problem Statement

### Background

Signals models two things. `items` is a partitioned table whose `item_state` is a JSONB
payload; its real schema lives in the network admin's `network.json`. `user` is the
better-auth-derived identity table, now shadowed by a Keycloak realm where
`keycloak.sub == signals.user.id`. `items.created_by` is `NOT NULL REFERENCES "user"(id)
ON DELETE RESTRICT`.

No rule was ever stated for which attributes belong to the account and which to the
profile. In practice both hold name, phone, email and age. The profile's copy is
schema-declared and, where marked `private: true`, encrypted into `item_private_state`.
The account's copy is plaintext.

Three creation modes exist, and only one of them supplies an account deliberately:

```
  1. self-signup      person ──▶ account (own anchor, OTP-verified) ──▶ profile
  2. aggregator bulk  CSV ──────▶ profile ──┐
                                            └──▶ account DERIVED from profile fields
  3. voice outbound   bot dials a number ───────▶ account+profile created mid-call
```

Because only the profile has a schema, modes 2 and 3 must manufacture the account. That
manufacture is the origin of every defect below.

### Problem Statement

**Problem 1 — the account is derived from profile data by regex.**
*Core challenge:* nothing declares which profile field is the account's identity, so the
platform guesses.

aggregator-dpg `packages/network-config/src/sniffer.ts:53` selects the account identity by
first match on field name (`/phone|mobile/i`, `/email/i`, `/name/i`) whenever
`field_overrides` is absent. Against the live `blue_dot` provider schema:

```
  job_posting_1.0 properties          sniffed account identity
  ──────────────────────────          ────────────────────────
  jobProviderName          ─────────▶ name   ← the COMPANY
  role
  jobProviderLocation
  hiringManagerName
  hiringManagerPhoneNumber ─────────▶ phone  ← an INDIVIDUAL EMPLOYEE
  hiringManagerEmail       ─────────▶ email  ← an INDIVIDUAL EMPLOYEE
```

The result is a chimera: a company's name on an employee's contact details, used as the
login anchor. With `user.phoneNumber UNIQUE` and identity matching on
`or(email, phone) LIMIT 1`, two failures follow directly:

```
  fragmentation                      cross-tenant merge
  ─────────────                      ──────────────────
  Acme + mgr A ──▶ account #1        Acme    + mgr X ──┐
  Acme + mgr B ──▶ account #2        Globex  + mgr X ──┴──▶ ONE account
  (one company, two accounts)        (two companies, one login sees both)
```

The second is a confidentiality break reachable through ordinary use, with no attacker.

**Problem 2 — four mappings answer "which field is the contact?", three optional.**
*Core challenge:* the only always-on answer is the heuristic.

| Mapping | Repo | Purpose | Enforced |
|---|---|---|---|
| `private: true` | Signals `network.json` | encrypt + mask | per field, optional |
| `contact_fields` | Signals `network.json` | outbound contact resolution | optional |
| `identity` selectors | aggregator YAML | derive account at ingest | optional |
| `sniffIdentitySelectors` | aggregator **code** | guess the above | **always** |

**Problem 3 — outbound resolves against the profile, inbound against the account.**
*Core challenge:* the platform dials a number it will then refuse to recognise.

`apps/api/src/utils/contact_fields.ts:169` resolves canonical contacts profile-first with
account fallback and `source: 'item' | 'user'` provenance. So `/campaign/voice` already
dials the hiring manager per posting. But `participant_read.ts:96-99` matches
`eq(user.email)` / `eq(user.phoneNumber)`, `LIMIT 1`, and returns `{user_id: null,
items: []}` on miss.

```
  outbound   campaign ──▶ decrypt ──▶ contact_fields ──▶ PROFILE phone ──▶ dial
  inbound    dialled number ──▶ GET /admin/participant ──▶ ACCOUNT only ──▶ not found
                                                                             │
                                        bot onboards the callee ◀────────────┘
                                        └─▶ duplicate, orphaned identity
```

**Problem 4 — attribution is a property of the person, not the profile.**
*Core challenge:* one write-once scalar is the tenancy key for six subsystems.

`user.onboardedByOrgId` is set at user creation (`participant.ts:84`) and never
re-evaluated. It gates participant disclosure (`participant_read.ts:129`), **PII decrypt**
(`participant_decrypt.ts:308`), action authorization (`_resolve_acting_actor.ts:115`),
dashboard (`dashboard.ts:166,212,223`), export (`export.ts:89`) and metrics
(`recompute.ts:131,254`). `items` has no org column at all;
`item_metrics.onboardedByOrgId` is a denormalised copy of `u.onboarded_by_org_id`
(`recompute.ts:244`).

```
   aggregator A onboards person P ──▶ user.onboarded_by_org_id = A   (frozen)
   aggregator B adds profile P2 for P
        B: sees [], cannot export, cannot decrypt  ← B's own work is invisible to B
        A: sees P2, exports P2, DECRYPTS P2        ← A never onboarded P2
```

> **Note:** `2026-07-22-iam-pending-decisions-for-product.md` already records
> *"ownership is per-listing, not per-account"* as 🟢 settled. The rule was agreed; the
> system does not implement it.

**Problem 5 — accountless profiles are legitimate but structurally impossible.**
*Core challenge:* a `NOT NULL` FK forces identity records for people who never registered.

`orange_dot` has one domain, `actions: {}`, and `required = [product_name, category,
description, area, verified_by]` — contact fields are optional. A practitioner profile
legitimately has no login and possibly no contact detail. Yet `items.created_by` is
`NOT NULL` and `POST /admin/participant` requires one of `email`/`phone_number`, so the
importer must fabricate an anchored account.

**Problem 6 — account PII is plaintext, and decryption authority is diffuse.**
*Core challenge:* the proven pattern exists in-repo and was never applied to `user`.

`packages/auth/src/pii_crypto.ts` provides a versioned (`v1:`) AES-256-GCM envelope, and
`minor_guardian.guardianRef` is a working deterministic-HMAC blind index. `user.name`,
`email`, `phoneNumber`, `age` and `location` use neither. `SIGNALS_PII_KEY` lives in
`process.env`, readable by anything that can exec into the pod. Separately, at least four
paths reveal PII — connect-acceptance, aggregator export, voice campaign, dashboard — and
only one (`pii_reveal_audit`, on `GET /action/:action_id/contact-details`) is audited.

**Problem 7 — filtering is open, indexing is closed, locations are half-projected.**
*Core challenge:* platform treatment of payload fields grew ad hoc, once as hardcoded DDL.

`filterable` was removed by #394, so every declared non-private enum field is filterable on
any network — while the indexes remain three hardcoded `blue_dot` seeker field names in
shared DDL (`create_items.sql:69-73`). Locations are declared
(`location: "primary"|"secondary"`) and geocoded into `item_locations`; the map expands
them (`item_fetch_runtime.ts:336,430,475`) but search stores one MultiPoint row per item
and reads only `ST_GeometryN(geo,1)` when an item is the search anchor
(`signals-search/src/api/search_route.ts:35-36`).

---

## 3. Key Design Problems

| | Design target | Direction |
|---|---|---|
| **P1** | Stop deriving accounts from profile data | Declared contract; derivation banned (§4.2) |
| **P2** | Collapse four contact mappings into one | Single `contacts` block, config-validated (§4.2) |
| **P3** | Make inbound and outbound resolve the same universe | Contact points + N-candidate resolution (§4.3) |
| **P4** | Move attribution from the person to the profile | `profile_origin`, immutable (§4.5) |
| **P5** | Permit profiles with no account holder | Custodian + nullable subject (§4.1) |
| **P6** | Define what the voice channel may do | Possession-scoped session grants (§4.4) |
| **P7** | Protect PII and bound who may decrypt | KMS KEK + purpose-bound grants (§4.6) |
| **P8** | Make payload projections declared, not ad hoc | Projection model (§4.7) |

---

## 4. Design

### 4.1 One conflation, three roles

The model's central move is to stop using one word for three things with incompatible
properties:

| Role | Verified | Unique | Authenticates | Belongs to |
|---|---|---|---|---|
| **Anchor** | must be | must be | **yes** | account |
| **Reachability** | need not be | need not be | **never** | profile |
| **Disclosure** | n/a | n/a | never | profile, consent-gated |

Once separated, the reported paradoxes stop being paradoxes. A consultant listed on five
postings holds five reachability addresses and zero anchors, so there is nothing to
disambiguate. Someone who answers a call has not thereby authenticated. And P1's
fragmentation and merge cannot occur, because an anchor is never derived from a
reachability address.

The second move follows from P5: a profile carries **two** roles that `created_by`
currently collapses into one.

- **Custodian** — accountable for the profile. Created it, may edit it, is credited for
  it, and is the tenancy key. An **account or an organization**.
- **Subject** — the person the dot represents. **Nullable.**

```
        ┌──────────────────────────── PROFILE ─────────────────────────────┐
        │  item_state (network-admin schema)                               │
        │  projections: contacts · locations · facets                      │
        └───────┬──────────────────────────────────────────┬───────────────┘
                │ custodian (accountable, tenancy key)     │ subject (nullable)
                ▼                                          ▼
      ┌───────────────────┐                     ┌─────────────────────┐
      │ ACCOUNT  or  ORG  │                     │ ACCOUNT (anchored)  │
      └─────────┬─────────┘                     └──────────┬──────────┘
                │ anchor (authenticates)                   │
                ▼                                          │
      ┌───────────────────┐                                │
      │  Keycloak realm   │◀───────────────────────────────┘
      └───────────────────┘
```

Three legitimate states, replacing today's single one:

```
   UNCLAIMED                    CLAIMED                      SELF-HELD
   custodian = org              custodian = org|account      custodian = account
   subject   = ∅                subject   = account          subject   = same account
   orange_dot practitioner      aggregator-onboarded seeker  self-signup
   no login, no actions         who verified and claimed
        │                              ▲
        └──────── claim (OTP) ─────────┘
```

**Why nullable rather than a placeholder account:** P5 is caused by a `NOT NULL`
constraint, and a sentinel row reproduces it under a different name — the phantom account
would still occupy an anchor, still be counted, still be visible. Nullability is the
honest representation of "nobody has claimed this dot yet".

**Claiming a contact point and claiming a profile are the same act.** The holder OTPs the
number; that mints or matches *their* account and attaches it as subject. The custodian is
unchanged, the transition is audited, and lineage is never inferred.

### 4.2 The contact contract

One declared block per domain in Signals' `network.json` replaces all four mappings from
P2. `network.json` in Signals-DPG is already the source of truth the aggregator syncs from,
so this removes a mapping rather than adding one.

```jsonc
"contacts": [
  { "field": "phone", "channel": "phone", "role": "self",
    "capabilities": ["reach", "act"] },
  { "field": "hiringManagerPhoneNumber", "channel": "phone", "role": "delegate",
    "capabilities": ["reach", "update_profile"] }
]
```

Three rules make it a contract rather than a hint:

1. **Config-validated, never sniffed.** `sniffIdentitySelectors` is deleted. A domain that
   enables actions must declare a binding or explicitly opt into anchor-fallback; neither
   fails config load. A loud startup failure is strictly better than a silent guess that
   merges two companies.
2. **An anchor is never derived from a contact field.** Bulk ingest supplies the anchor
   explicitly, or the profile is created **unclaimed** under the aggregator org.
3. **`role` is declared by the network admin**, who authors the field anyway. This is also
   what makes third-party notice statable: the form can tell the employer what entering
   that number will cause.

> **Note on staging:** the unclaimed path in rule 2 depends on §4.1, which lands in P6 of
> the decomposition. Until then rule 2 **rejects** an anchor-less upload. Rejecting an
> ambiguous row is safer than merging two companies, so P1 is still worth landing first.

### 4.3 Contact points and symmetric resolution

Reachability addresses become first-class rather than values buried in JSONB: one row per
`(channel, value)`, encrypted, with a deterministic HMAC `value_ref` carrying uniqueness
and serving every lookup. Profiles reference them through a join carrying `role`,
`source_field` and `capabilities`.

```
   contact_point (+91XXXXXXXX)          ← ONE row, deduped on value_ref
        ├── profile: Acme  · role=delegate · caps=[reach, update_profile]
        ├── profile: Globex· role=delegate · caps=[reach, update_profile]
        └── account: (none)                    ← no anchor, so no authority
```

This is the honest representation of the consultant case, and it makes inbound resolution
tractable. `resolve(channel, value)` returns **every** candidate with provenance, plus any
anchor match flagged separately — never `LIMIT 1`:

```
   resolve(phone, +91XXXXXXXX)
     ├─ anchor match      : account #42                     (authenticates)
     ├─ contact match     : profile P1, custodian Acme,   role=delegate
     └─ contact match     : profile P2, custodian Globex, role=delegate
```

Disambiguation becomes a stated policy applied to a complete candidate set, rather than
whatever the query planner returned first.

### 4.4 Voice: possession, not identity

A voice channel proves *possession of a handset*, which is a real but bounded factor, and
its strength depends entirely on who dialled.

```
   OUTBOUND (we dialled)                  INBOUND (they dialled)
   we chose the number                    caller ID is network-asserted
   the callee answered it                 and spoofable
   ⇒ possession proven                    ⇒ nothing proven
   ⇒ verified channel, ≈ SMS OTP          ⇒ untrusted until callback / OTP
```

A session therefore receives a **grant**, not a login:

```
   grant = verified_channel
         ∩ declared capabilities of the bindings that resolved
         ∩ profile lifecycle state
   scope = those profiles ONLY — never account-wide, never sibling profiles
```

A delegate may update the posting their number appears on precisely because the custodian
designated them by entering it; that designation is now explicit (§4.2) and disclosable
(P12 in the product note).

**A voice session cannot mint an account.** It creates an *unclaimed* profile custodied by
the calling org, or claims an existing one (§4.1). The duplicate-identity failure in P3 is
removed rather than defended against.

### 4.5 Attribution: immutable origin, mutable tags

P4 conflates two different things under `user.onboardedByOrgId` and `user.tags`. They
separate cleanly:

- **`profile_origin`** — one row per profile, written once, never updated: custodian org,
  creating actor, channel, **campaign id**, source id, timestamp. This becomes the tenancy
  key replacing `user.onboardedByOrgId`. It is an *event fact*; a later editor must not be
  able to overwrite who created it.
- **`profile.tags`** — mutable ops markers (`is_test`, migration batch), JSONB + GIN,
  mirroring today's `user.tags`.

Campaign reporting falls out directly, uniform across bulk CSV and voice:

```
   profiles from a campaign : count(*) FROM profile_origin WHERE campaign_id = ?
   accounts from a campaign : count(*) FROM claim_event    WHERE campaign_id = ?
                              └─ counts VERIFIED HUMANS, not importer-manufactured rows
```

### 4.6 PII at rest and decryption authority

**The account, minimised.** Requirement: an anchor plus accepted terms, and nothing else
mandatory. Everything else on `user` has a better home.

| Today on `user` | Target |
|---|---|
| `name`, `location`, `image` | profile facts; not account columns |
| `email`, `phoneNumber`, `*Verified` | anchors — value in Keycloak, `value_ref` in Signals |
| `termsAccepted`, `privacyAccepted` | delete; `consent_record` is already the ledger (#309) |
| `age` | a **gate**, not an attribute — `is_minor` + re-evaluation date |
| `onboardedBy*` | → `profile_origin` (§4.5) |
| `domains` | → subject policy (§4.7) |
| `tags`, `role`, `banned*` | stay — ops/authz, not PII |

**One store per purpose.** Keeping `user` alongside Keycloak means two writable copies of
one identifier: drift, and two breach surfaces for one value. Resolved by purpose rather
than by picking a winner:

```
   AUTHENTICATION          Keycloak realm   ── holds the anchor value
   UNIQUENESS / LOOKUP     Signals          ── holds value_ref (HMAC) ONLY
   REACHABILITY            Signals          ── contact_point ciphertext, role=self
```

Signals therefore holds no recoverable account identifier. This does not make Signals
PII-free — contact points hold ciphertext by necessity — but the *authenticating*
identifier is not recoverable from the application database.

> **Note:** this presumes `AUTH_PROVIDER=keycloak`. Under the legacy `betterauth` mode
> there is no realm to own anything, so this step is gated per instance on the deployed
> provider.

**Purpose-bound decrypt grants.** P6's second half: four reveal paths differing in
principal, scope, volume and lawful basis, separated only by acting-org checks and the
broken key from P4.

```
   request(purpose, principal, scope, justification_ref)
        │
        ├─ policy: does this purpose admit this scope for this principal?
        ├─ projection: return ONLY the fields this purpose needs
        ├─ audit: ONE record, all paths (today only 1 of 4 is audited)
        └─ quota: per purpose

   connect_reveal  → single target, single field
   voice_campaign  → one grant over the job's item set
   agg_export      → one grant over the custodian's attributed set  ← correct only after §4.5
```

**The grant is the auditable event.** "This aggregator requested an export grant covering
40k subjects at 03:00" is a detectable anomaly; "the application decrypted 40k rows" is
not.

**Key model.** A single KEK held in KMS, not `process.env` — today's key is readable by
anything that can exec into the pod, a wider set than "has database access". Per-unit
envelope keys were considered and rejected: against a database dump they change nothing
(the key is not in the database either way), and their two real benefits are an auditable
chokepoint — which grants deliver on their own — and cryptographic erasure, which requires
*stored destroyable* DEKs and therefore N unwraps per bulk grant on exactly the
highest-volume paths. Derived DEKs would be cheap but cannot be destroyed, forfeiting the
only benefit that justified them. The `v1:` prefix leaves envelopes addable without a
format break. **Revisit if legal establishes that erasure must reach immutable backups.**

The **blind-index pepper is necessarily system-wide** — shared determinism is what makes
refs comparable — and must be a separate secret in a separate blast radius from the KEK.
Rotation invalidates every ref and requires a rebuild; that story is decided now, not
during an incident.

### 4.7 Declared projections

P7's real content: `item_state` is opaque and network-admin-owned, but the platform must
act on specific values inside it. That one concept was invented eight times, once as
hardcoded DDL and once as a regex. A **projection** is a declared instruction to lift a
value out of the payload and give it first-class treatment. The network admin's authority
over field content is unchanged; the platform stops guessing.

```
   item_state (JSONB, network-admin schema)
        │
        ├─ private       ──▶ item_private_state (encrypted) + masked mirror   [exists]
        ├─ vectorize     ──▶ item_search.embedding                            [exists]
        ├─ location      ──▶ profile_location, ONE ROW PER POINT              [changed]
        ├─ contacts      ──▶ contact_point + profile_contact                  [new, §4.2]
        └─ facet         ──▶ generated expression indexes                     [changed]
```

**Locations, one row per point.** One profile, N locations, N map pins, one card. Replaces
query-time `jsonb_array_elements` expansion with a join and per-point GiST indexing, and
fixes the anchor collapse in P7 — "search near this profile" can select the relevant point,
and "nearest opening" becomes answerable. *(This leaves a seam for per-location lifecycle;
that is explicitly **not** proposed.)*

**Facets, generated indexes.** The alternative was a facet side-table (EAV), which is more
flexible but gives the planner worse statistics and rewrites every read path. Generating
today's expression indexes from the declared config at migration time keeps the existing
btrees and changes no read path; the cost is a migration step when a facet declaration
changes. This removes the network-specific DDL.

**Limits and subject policy, configurable.** No one-dot-per-person limit exists today, so
this specifies the mechanism, not the policy — absent config means unlimited, explicitly.

- **Per-subject cap**, scoped `(network, domain, item_type)`, from `network.json`. Today's
  advisory-lock check (`item_service.ts:assertProfileLimit`) is mechanically correct and
  ports as-is; it is keyed on the wrong column, not built wrong.
- **Per-custodian quota** on the organization record, not `network.json` — contractual,
  with a different lifecycle and authority.
- **Evaluated at create *and* at claim.** A claim moves a profile under a subject; skipping
  it there makes claiming a cap bypass.
- **`user.domains` is the same family** — a subject policy, "which domains may this subject
  hold profiles in". Config-driven is what lets the open-network relaxation later be a
  config change rather than a code change.

### 4.8 Open questions and provisional premises

- Whether an account may be a **legal entity** distinct from the humans acting for it. The
  model holds either way; the organization-custodian half of §4.1 depends on it. *(open —
  product)*
- Whether an org-custodied profile **survives** its subject's erasure under the custodian's
  own lawful basis. *(open — legal)*
- Cold-path **disambiguation policy** when §4.3 returns N candidates. *(open — product)*
- Third-party **notice** for delegate contact fields. *(open — legal)*
- All new tables and endpoints below are **(planned)**; nothing in §5–§6 is built.

---

## 5. Data Model

All columns snake_case. New unless marked.

### `account`

| Column | Type | Description |
|---|---|---|
| `id` | text PK | _**unchanged from `user.id`** — `keycloak.sub`, and the key `items.created_by` and every `*_owner` column already use. Not re-minted._ |
| `status` | text | `active` \| `banned` \| `closed` |
| `role` | text | platform role; ops/authz, not PII |
| `tags` | jsonb | ops markers (`is_test`); GIN |
| `created_at` | timestamptz | |

_No name, location, email, phone or age. See §4.6._

### `account_anchor`

| Column | Type | Description |
|---|---|---|
| `account_id` | text FK → `account.id` | |
| `channel` | text | `phone` \| `email` |
| `value_ref` | text | _**HMAC-SHA256(pepper, normalise(channel, value))**. Carries the `UNIQUE (channel, value_ref)` constraint. **No ciphertext column** — the value lives in Keycloak (§4.6)._ |
| `verified_at` | timestamptz | null = unverified |

### `account_minor_gate`

| Column | Type | Description |
|---|---|---|
| `account_id` | text PK FK | |
| `is_minor` | boolean | _the **decision**, not the age (§4.6)_ |
| `reevaluate_after` | date | _derived at capture from the age snapshot (#331)_ |

### `contact_point`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `channel` | text | `phone` \| `email` |
| `value_ct` | text | `pii_crypto` envelope, `v1:` prefixed |
| `value_ref` | text | HMAC blind index; `UNIQUE (channel, value_ref)` — **dedupe key** |
| `verified_at` | timestamptz | null = asserted by a third party, never verified |
| `created_at` | timestamptz | |

### `profile_contact`

| Column | Type | Description |
|---|---|---|
| `profile_id` | uuid | FK-less (partitioned parent); app-level integrity |
| `contact_point_id` | uuid FK | |
| `role` | text | `self` \| `delegate` — _**declared** in `network.json`, never inferred_ |
| `source_field` | text | the `item_state` field it was projected from |
| `capabilities` | text[] | `reach` \| `act` \| `update_profile` |

### `profile` (evolution of `items`)

| Column | Type | Description |
|---|---|---|
| `custodian_kind` | text | `account` \| `organization` — _**replaces the semantics of `created_by`**_ |
| `custodian_id` | text | account id or org id |
| `subject_account_id` | text **NULL** | _**nullable** — the change that makes unclaimed profiles possible (§4.1). Supersedes `created_by NOT NULL REFERENCES "user"(id)`._ |
| `tags` | jsonb | ops markers; GIN |
| _(all existing item columns unchanged)_ | | |

### `profile_origin`

| Column | Type | Description |
|---|---|---|
| `profile_id` | uuid PK | |
| `custodian_org_id` | text | _**the tenancy key replacing `user.onboarded_by_org_id`** (§4.5)_ |
| `created_by_actor` | text | account or service identity that performed creation |
| `channel` | text | `self` \| `bulk` \| `link` \| `voice` \| `migration` |
| `campaign_id` | text | _nullable; the campaign-reporting key_ |
| `source_id` | text | opaque upstream key |
| `created_at` | timestamptz | |

_**Immutable.** Written once at creation; no update path exists. Index
`(custodian_org_id, created_at)` and `(campaign_id)`._

### `profile_location`

| Column | Type | Description |
|---|---|---|
| `profile_id` | uuid | |
| `seq` | int | position within the declared array |
| `geo` | `geography(Point,4326)` | _**one row per point** (§4.7) — GiST indexed_ |
| `label` | text | place name when known |

### `claim_event`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `profile_id` | uuid | |
| `contact_point_id` | uuid | the contact point that was verified |
| `account_id` | text | the account attached as subject |
| `campaign_id` | text | _nullable; feeds the "verified humans" metric (§4.5)_ |
| `claimed_at` | timestamptz | |

_Append-only. Lineage record for §4.1's claim transition._

### `decrypt_grant`

| Column | Type | Description |
|---|---|---|
| `id` | uuid PK | |
| `purpose` | text | `connect_reveal` \| `voice_campaign` \| `agg_export` \| `dashboard` |
| `principal_id` | text | account or org |
| `scope_ref` | jsonb | item set, custodian set, or single target |
| `fields` | text[] | the projection this purpose is allowed |
| `justification_ref` | text | action id, campaign job id, export request id |
| `granted_at` / `expires_at` | timestamptz | |

_Supersedes `pii_reveal_audit` as the single audit record across all four paths (§4.6)._

---

## 6. API Spec

All **(planned)**.

### Public endpoints

#### `POST /api/v1/profile/{profile_id}/claim`
Request:
```jsonc
{
  "channel": "phone",          // which declared contact point is being claimed
  "otp": "123456",             // proves possession
  "campaign_id": "camp_88"     // optional; attributes the claim (§4.5)
}
```
Responses: `200 { account_id, created }`, `409 { error: "SUBJECT_ALREADY_ATTACHED" }`,
`409 { error: "PROFILE_LIMIT_REACHED" }`, `403 { error: "CONTACT_ROLE_NOT_CLAIMABLE" }`.
Validation:
- the contact point must be declared `role: self` for the domain (§4.2) — a `delegate`
  binding is reachability-only and cannot be claimed into subjecthood
- the per-subject cap is re-evaluated here, not only at create (§4.7)
- mints the account if the OTP'd value matches no existing anchor; otherwise attaches the
  existing one

### Admin / service endpoints

#### `POST /api/v1/identity/resolve`
Replaces account-only `GET /api/v1/admin/participant` lookup (P3).
Request:
```jsonc
{ "channel": "phone", "value": "+91XXXXXXXXXX", "network": "blue_dot" }
```
Response `200`:
```jsonc
{
  "anchor_match": { "account_id": "usr_42" } ,      // or null
  "contact_matches": [                              // 0..N — never truncated
    { "profile_id": "…", "custodian_kind": "organization", "custodian_id": "org_a",
      "role": "delegate", "capabilities": ["reach","update_profile"],
      "subject_account_id": null }
  ]
}
```
Validation:
- **never `LIMIT 1`**; an ambiguous number returns every candidate with provenance
- results are scoped to the caller's acting org via `profile_origin.custodian_org_id`
  (§4.5), not `user.onboarded_by_org_id`

#### `POST /api/v1/voice/session`
Request:
```jsonc
{
  "origin": "outbound",        // "outbound" | "inbound" — determines trust (§4.4)
  "channel": "phone",
  "value": "+91XXXXXXXXXX",
  "campaign_job_id": "job_17"  // required when origin=outbound; carries the warm context
}
```
Response `200 { session_id, grants: [{ profile_id, capabilities }], expires_at }`.
Validation:
- `origin: "inbound"` yields **no** write capabilities until upgraded by callback or OTP
- capabilities are the intersection defined in §4.4; never account-wide
- the session **cannot** create an account; an unmatched number may create an *unclaimed*
  profile under the calling org

#### `POST /api/v1/pii/grant`
Request:
```jsonc
{
  "purpose": "voice_campaign",
  "scope": { "item_ids": ["…"] },
  "fields": ["name", "phone"],
  "justification_ref": "job_17"
}
```
Responses: `200 { grant_id, expires_at }`, `403 { error: "PURPOSE_SCOPE_DENIED" }`,
`429 { error: "PURPOSE_QUOTA_EXCEEDED" }`.
Validation:
- scope admissibility is checked against `profile_origin.custodian_org_id`
- `fields` is intersected with the purpose's allowed projection — a purpose cannot widen
  itself
- one audit row per grant, across all four reveal paths (§4.6)

#### `POST /api/v1/admin/participant/decrypt` *(changed)*
Unchanged shape; now requires a `grant_id` and returns only the granted `fields`. The
implicit account-fallback disclosure it performs today
(`contact_fields.ts:169`, `source: "user"`) becomes an explicit part of the grant rather
than a silent widening.

---

## 7. Summary

The account/profile boundary was never stated, so the platform inferred it — by regex, at
ingest. That single inference is the root of a company being split across accounts, two
companies being merged under one hiring manager's login, aggregators decrypting each
other's participants, and phantom accounts for people who never registered.

The model states the boundary. An **account** is an anchor plus consent, nothing more. A
**profile** is the dot, held by a **custodian** (account or organization) and optionally
about a **subject** (nullable). A **contact point** is reachability, first-class and
deduped, and never authenticates. Attribution moves to the profile as an immutable
**origin** record. The voice channel gets **possession-scoped grants** rather than logins,
and can no longer mint accounts. PII moves under a KMS-held key with **purpose-bound
decrypt grants** as the single audited chokepoint.

Net effect: three defects reachable through ordinary use today are removed by construction
rather than patched; campaign metrics count verified humans; and the "network admin owns
the schema" claim stops being contradicted by shared DDL and a regex in another repo.

**Phasing** — ordered so everything landing first holds under either answer to §4.8's
entity-vs-person question:

| | Sub-project | Depends on |
|---|---|---|
| P1 | Delete the sniffer; declared `contacts` block; anchor-less upload rejected | — |
| P2 | `profile_origin` + profile `tags`; re-key tenancy | — |
| P3 | Account PII: KMS KEK, anchors as refs, U18 gate, drop deprecated columns | — |
| P4 | Purpose-bound decrypt grants + unified audit | P2 |
| P5 | Contact points; N-candidate resolution | P1, P3 |
| P6 | Custodian/subject split; unclaimed profiles; claim flow | P2, P5, §4.8 |
| P7 | Voice session grants (warm context + cold path) | P5, P6 |
| P8 | `profile_location`; generated facet indexes | — |
| P9 | Configurable limits and subject domain policy | P6 |

P6 rewrites `items.created_by NOT NULL REFERENCES "user"(id)` — the most load-bearing
constraint in the schema — which is why it is sequenced late rather than first.

**Remaining open:** the four items in §4.8, tracked as D9–D14 in
`2026-08-30-account-profile-identity-questions-for-product.md`, alongside D1–D8 from
2026-07-22 which remain unanswered.
