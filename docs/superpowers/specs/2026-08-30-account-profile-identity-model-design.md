# Account, Profile and Identity — Target Model

**Status:** design, awaiting review
**Date:** 2026-08-30
**Scope:** Signals-DPG (`user`, `items`), with consequences for aggregator-dpg
(bulk ingest, campaign) and signals-search (locations).

Companion: `2026-08-30-account-profile-identity-questions-for-product.md`
Prior art: `2026-07-22-iam-pending-decisions-for-product.md` (D1/D4/D6/D7 are
not restated here).

---

## 1. Problem

Signals models two things — a `user` row (better-auth origin, now mirrored into
Keycloak) and an `items` row whose real schema comes from the network admin's
`network.json`. There has never been a stated rule for which attributes belong
to which. That absence is now producing concrete defects: cross-tenant data
exposure, mis-attributed aggregator work, phantom accounts, and a voice
integration that dials numbers the platform then refuses to recognise.

This document states the target model. It is derived from requirements, not
from the present schema; migration is deliberately treated separately so it
cannot bend the model.

---

## 2. What the code does today

Verified against the working tree at `origin/feature` (cdee882d).

**2.1 Contact resolution is profile-first, and already used in production.**
`apps/api/src/utils/contact_fields.ts:169` resolves canonical `name/email/phone`
from `item_state` via the domain's `contact_fields` map, falling back to the
`user` row with `source: 'item' | 'user'` provenance. `blue_dot` maps
`seeker → {name, phone}` and `provider → {jobProviderName,
hiringManagerPhoneNumber, hiringManagerEmail}`. The campaign path
(aggregator `apps/worker/src/services/campaign-process/voice.ts:298` →
`POST /api/v1/admin/participant/decrypt`) therefore already dials the hiring
manager per posting, not the account holder.

**2.2 Inbound lookup is account-only.** `participant_read.ts:96-99` matches
`eq(user.email, …)` / `eq(user.phoneNumber, …)`, `or(...)`, `LIMIT 1`, and
returns `{user_id: null, items: []}` on miss. The platform dials a number it
cannot then resolve. A voice flow that reacts by onboarding the callee mints a
duplicate, orphaned identity.

**2.3 The account is derived from profile data by regex.**
aggregator-dpg `packages/network-config/src/sniffer.ts:53` picks the account
identity by first-match on field name — `/phone|mobile/i`, `/email/i`,
`/name/i` — whenever `field_overrides` is absent. Against live `blue_dot`
schemas this yields, for `provider/job_posting_1.0`:

    name  = jobProviderName            (the company)
    phone = hiringManagerPhoneNumber   (an individual employee)
    email = hiringManagerEmail

A chimera: a company's name on an employee's contact details, as the login
anchor. With `user.phoneNumber UNIQUE` and identity matching on
`or(email, phone) LIMIT 1`, this produces two live defects:

- **Company fragmentation** — two postings with different hiring managers
  create two accounts, both named the same company.
- **Cross-tenant ownership merge** — one hiring manager consulting for two
  companies collides on the unique phone, so both companies' postings end up
  owned by one account. Whoever holds that number controls both. No attacker
  required.

**2.4 Four competing answers to "which field is the contact?"** —
`private` and `contact_fields` (Signals `network.json`), `identity` selectors
(aggregator YAML), and `sniffIdentitySelectors` (aggregator code). Three are
optional; the always-on one is a heuristic.

**2.5 Attribution sits on the person, not the profile.**
`user.onboardedByOrgId` is a single scalar written once at user creation
(`participant.ts:84`) and never re-evaluated. It is the sole tenancy key for
participant disclosure (`participant_read.ts:129`), **PII decrypt
authorization** (`participant_decrypt.ts:308`), action authorization
(`_resolve_acting_actor.ts:115`), dashboard (`dashboard.ts:166,212,223`),
export (`export.ts:89`) and metrics (`recompute.ts:131,254`). `items` has no
org column; `item_metrics.onboardedByOrgId` is a denormalised copy of
`u.onboarded_by_org_id` (`recompute.ts:244`). Consequences: aggregator B cannot
see or decrypt a profile B created on A's user; A retains decrypt rights over
profiles it never onboarded; dashboards credit B's work to A; a self-signed-up
user is invisible to every aggregator forever.

**2.6 Accountless profiles are legitimate but impossible.** `orange_dot` has one
domain, `actions: {}`, and `required = [product_name, category, description,
area, verified_by]` — contact fields are optional. Yet `items.created_by` is
`NOT NULL REFERENCES "user"(id)` and `POST /admin/participant` requires one of
`email`/`phone_number`. The importer is structurally forced to fabricate an
anchored account.

**2.7 Filtering is open, indexing is closed.** `filterable` was removed (#394):
every declared non-private enum field is filterable on any network. The indexes
remain three hardcoded `blue_dot` seeker field names in shared DDL
(`packages/database/src/utils/sql_scripts/core/create_items.sql:69-73`). Other
networks' facet filters are sequential scans.

**2.8 Locations.** `packages/schemas/src/location_fields.ts` defines
`location: "primary" | "secondary"`; one primary field per domain is geocoded
into `item_locations`. The map expands `jsonb_array_elements(item_locations)`
(`item_fetch_runtime.ts:336,430,475`). Search keeps one row per item with
`geo geography(MultiPoint,4326)`: `ST_DWithin`/`ST_Distance` are multipoint-
correct, but an item used as a *search anchor* reads only `ST_GeometryN(geo,1)`
(`signals-search/src/api/search_route.ts:35-36`).

**2.9 PII.** `packages/auth/src/pii_crypto.ts` provides a versioned
(`v1:`) AES-256-GCM envelope; `minor_guardian.guardianRef` is a working
deterministic-HMAC blind index. The `user` table adopted neither: `name`,
`email`, `phoneNumber`, `age`, `location` are plaintext. `SIGNALS_PII_KEY`
lives in `process.env`. `pii_reveal_audit` covers exactly one reveal path
(`GET /action/:action_id/contact-details`); `participant_decrypt`, export and
dashboard are unaudited by comparison. `consent_record` is already a correct
append-only versioned ledger at user and item level;
`user.termsAccepted`/`privacyAccepted` are deprecated and ignored (#309).

---

## 3. Requirements

- **R1** To be on the platform: an identity anchor, acceptance of current
  terms, and a way to be reached. Nothing more is mandatory.
- **R2** A profile is a dot on the map: schema-typed, discoverable,
  searchable, indexable.
- **R3** The network admin owns profile schemas and interaction rules; the
  platform cannot dictate field content.
- **R4** Some domains have no login and no interactions. Profiles there need no
  account holder.
- **R5** A subject may hold several profiles, including of the same type,
  carrying contact details other than their account's.
- **R6** Every profile must be reachable; notifications and calls are delivered
  per profile.
- **R7** Voice must work outbound (context known at dispatch) and inbound (only
  a number known).
- **R8** A profile's contact may be a third party who never registered and
  never consented.
- **R9** PII must not be readable from database access alone.
- **R10** Profile ownership and lineage must be unambiguous and auditable.
- **R11** Currently one domain type per subject; open participation is the
  eventual goal, and the restriction must be config, not code.
- **R12** Business needs counts of accounts and profiles created by a campaign
  (bulk CSV or voice), and markers for test and migrated data.

---

## 4. The conflation

One word — "contact" — does three jobs with incompatible properties:

| Role | Verified | Unique | Authenticates | Belongs to |
|---|---|---|---|---|
| **Anchor** — proves who is acting | must be | must be | yes | account |
| **Reachability** — where a message about a signal goes | need not be | need not be | **never** | profile |
| **Disclosure** — what a counterparty sees after connect | n/a | n/a | never | profile, consent-gated |

Separating them dissolves the reported paradoxes. A consultant on five postings
holds five reachability addresses and zero anchors. Someone who answers a call
is not thereby authenticated. Company fragmentation cannot occur, because an
anchor is never derived from a reachability address.

The second gap follows from R4 and the three creation modes (self-signup,
aggregator upload, voice outbound): **the account has no capture contract.**
Only the profile has a schema, so every non-self-signup mode invents the
account from profile data. The fix is not a better sniffer — an anchor must be
supplied *as an anchor* or not exist at all, which requires profiles to be
ownable by an organization.

---

## 5. Entity model

**Anchor** — a verified, unique, channel-specific identifier that
authenticates. Never derived from profile data.

**Account** — an anchor plus accepted terms. That is the whole mandatory
content. A principal, not a description of anybody.

**Profile** — the dot: schema-typed payload plus a declared reachability
binding.

**Contact point** — a reachability address: deduped, encrypted, blind-indexed,
referenced by profiles. Never authenticates.

A profile carries two distinct roles, today collapsed into `created_by`:

- **Custodian** — accountable for the profile: created it, may edit it, is
  credited for it, and is the tenancy key. An account **or** an organization.
- **Subject** — the person the dot represents. **Nullable.**

| State | Custodian | Subject | Case |
|---|---|---|---|
| Unclaimed | organization | none | `orange_dot` practitioner: no login, no actions, no phantom account |
| Claimed | organization or account | an anchored account | aggregator-onboarded seeker who later verifies |
| Self-held | account | same account | self-signup |

Claiming a contact point and claiming a profile are the same act: the holder
OTPs the number, which mints or matches *their* account and attaches it as
subject. Custodian is unchanged, the transition is audited, and lineage never
has to be guessed.

---

## 6. The contact contract

One declared block per domain in Signals' `network.json`, replacing all four
mappings in §2.4:

```json
"contacts": [
  { "field": "phone", "channel": "phone", "role": "self",
    "capabilities": ["reach", "act"] },
  { "field": "hiringManagerPhoneNumber", "channel": "phone", "role": "delegate",
    "capabilities": ["reach", "update_profile"] }
]
```

Three rules make it a contract rather than a hint:

1. **Validated at config load, never sniffed.** `sniffIdentitySelectors` is
   deleted. A domain enabling actions must declare a binding or explicitly opt
   into anchor-fallback; neither means config validation fails.
2. **An anchor is never derived from a contact field.** Bulk upload supplies
   the anchor explicitly, or the profile is created **unclaimed** under the
   aggregator org (the unclaimed path arrives with P6; until then P1 rejects the
   ambiguous upload — see §10). This single rule removes the chimera, the fragmentation and
   the cross-tenant merge of §2.3.
3. **`role` is declared by the network admin**, who is authoring the field
   anyway. Declaring it is also what makes the third-party notice statable: the
   form can tell the account holder what naming that number will cause.

**Contact points become first-class.** One row per `(channel, value)`:
ciphertext plus a deterministic HMAC `value_ref` carrying the uniqueness
constraint and serving all lookups. Profiles reference them through a join
carrying `role`, `source_field` and `capabilities`. Dedupe on `value_ref`, so
the consultant's number is one contact point referenced by five profiles.

**Inbound resolution returns a set, never a row.** `resolve(channel, value)`
yields every `{contact_point, profile, custodian, role, capabilities,
subject?}`, with anchor matches flagged separately. The `LIMIT 1` of §2.2 is
replaced by an explicit N-candidate answer with provenance; disambiguation
becomes stated policy.

### 6.1 Voice authority boundary

| Session origin | What is proven | Consequence |
|---|---|---|
| Outbound (we dialled) | possession of the handset — the callee answered a number we chose | verified channel, comparable to an SMS OTP |
| Inbound (they dialled) | nothing; caller ID is network-asserted and spoofable | unverified until upgraded by callback or OTP |

A session receives a **grant**, not a login: the intersection of the verified
channel, the declared `capabilities` of the bindings that resolved, and the
profile's lifecycle state — scoped to those profiles only, never account-wide.
A delegate may update the posting their number is on precisely because the
custodian designated them by entering it, and that designation is now explicit
and disclosable.

A voice session cannot mint an account. It creates an **unclaimed** profile
custodied by the calling org, or claims an existing one. No path fabricates an
anchor.

---

## 7. Declared projections

`item_state` is an opaque payload the network admin owns, but the platform must
act on specific values inside it. That single concept has been invented eight
times across two repos (§2.4, §2.7, §2.8), once as hardcoded DDL and once as a
regex. A **projection** is a declared instruction to lift a value out of the
payload and give it first-class treatment. The network admin's authority is
unchanged; the platform stops guessing.

**Locations → `profile_location`, one row per point.** One profile, N
locations, N map pins, one card. Replaces query-time `jsonb_array_elements`
expansion with a join and per-point GiST indexing, and fixes the anchor
collapse of §2.8 — "search near this profile" can choose the relevant point,
and "nearest opening" becomes answerable. (This leaves a seam for per-location
lifecycle; that is explicitly not proposed.)

**Facets → generated expression indexes.** Options were a facet side-table
(EAV) or generating today's expression indexes from the declared config at
migration time. Generated indexes are recommended: they keep the existing
planner-friendly btrees and change no read path, at the cost of a migration
step when a facet declaration changes. This removes the network-specific DDL of
§2.7.

**Attribution → immutable origin plus mutable tags.** Two different things,
today conflated:

- **`profile_origin`** — one row per profile, written once, never updated:
  custodian org, creating actor, channel (`self | bulk | link | voice |
  migration`), **campaign id**, source id, timestamp. This is the tenancy key
  that replaces `user.onboardedByOrgId`, resolving every consequence in §2.5.
  It is an event fact; a later editor must not overwrite who created it.
- **`tags` on the profile** — mutable ops markers (`is_test`, migration
  batch), jsonb + GIN, mirroring today's `user.tags`.

R12 then falls out: profiles created by a campaign is
`count(*) from profile_origin where campaign_id = ?`, uniform across bulk CSV
and voice. Accounts created by a campaign becomes a count of **claim** events
carrying that campaign id — a better number than today's, because it counts
verified humans rather than rows the importer manufactured.

**Limits and domain policy → configurable, never constants.** No
one-dot-per-person limit exists today; this specifies the mechanism, not the
policy. Absent config means unlimited, explicitly.

- **Per-subject cap**, scoped `(network, domain, item_type)`, from
  `network.json`. Today's advisory-lock check
  (`item_service.ts:assertProfileLimit`) is mechanically correct and ports
  as-is; it is keyed on the wrong column, not built wrong.
- **Per-custodian quota** on the organization record, not `network.json` — it
  is contractual, with a different lifecycle and authority.
- **Evaluated at create *and* at claim.** A claim moves a profile under a
  subject; skipping it there makes claiming a cap bypass.
- **`user.domains` (R11) is the same family** — a subject policy, "which
  domains may this subject hold profiles in". Config-driven per network is what
  lets the open-network relaxation later be a config change, not a code change.

---

## 8. Account record, PII and decrypt authority

### 8.1 The account, minimised

| Today on `user` | Target |
|---|---|
| `name`, `location`, `image` | profile facts; not account columns |
| `email`, `phoneNumber`, `*Verified` | become anchors (§8.2) |
| `termsAccepted`, `privacyAccepted` | delete — `consent_record` is the ledger (#309) |
| `age` | becomes a gate (§8.3) |
| `onboardedBy*` | → `profile_origin` (§7) |
| `domains` | → subject policy (§7) |
| `tags`, `role`, `banned*` | stay — ops/authz, not PII |

What remains is an id, a status, timestamps and policy.

### 8.2 Anchors: one store per purpose

The defect in keeping `user` alongside Keycloak is *two writable copies of one
identifier* — drift, and two breach surfaces for one value. Resolved by purpose:

- **Keycloak owns the authenticating anchor.** It already does; `sub ==
  user.id` holds and `items.created_by` keys on that id. This presumes
  `AUTH_PROVIDER=keycloak`; under the legacy `betterauth` mode there is no realm
  to own anything, so P3 in §10 is gated on Keycloak being the deployed provider
  for the instance in question.
- **Signals stores only `value_ref`**, the HMAC blind index. That suffices for
  uniqueness, dedupe and §6 inbound resolution, none of which need plaintext.
  Signals holds no recoverable account identifier.
- **Reachability is a separate record.** Notifications on a login phone are a
  `contact_point` with `role: self`, verified, linked to the account. Same
  value, two purposes, two records — which also gives erasure granularity:
  "stop contacting me" drops the contact point without destroying the login.

This does not make Signals PII-free; contact points hold ciphertext by
necessity. The narrower claim is that the *authenticating* identifier is not
recoverable from the application database.

### 8.3 The U18 gate replaces stored age

The requirement is "is this person a minor?", not "how old are they". Store the
decision and its re-evaluation horizon, derived at capture from the age
snapshot (#331), rather than the attribute. Strictly less child data and
purpose-bound. Caveat: a boolean plus a date still infers approximate age; it
is coarser and narrower, not zero.

### 8.4 Purpose-bound decrypt grants

Decryption authority is currently diffuse: at least four reveal paths
(connect-acceptance, aggregator export, voice campaign, dashboard) differing in
principal, scope, volume and lawful basis, separated only by acting-org checks
and `user.onboardedByOrgId` — so the §2.5 defect over-broadens decryption too.

Every decryption becomes a request carrying `(purpose, principal, scope,
justification-ref)`. The platform resolves whether that purpose admits that
scope for that principal, returns **only the fields that purpose needs**, writes
one unified audit record, and applies per-purpose quotas. A connect reveal is a
single-target single-field grant; a campaign is one grant over its item set; an
export is one grant over the custodian's attributed set — which §7 makes
correct for the first time.

**The grant is the auditable event.** "This aggregator requested an export grant
covering 40k subjects at 03:00" is a detectable anomaly; "the app decrypted 40k
rows" is not. Both existing audit paths write the same record.

### 8.5 Key model

**A single KEK held in KMS, not `process.env`.** Today's `SIGNALS_PII_KEY` is
readable by anything that can exec into the pod or read the deployment spec — a
wider set than "has database access". Moving it to KMS is the substantive win.

Per-unit envelope keys were considered and rejected for now. Against a database
dump they change nothing (the key is not in the database either way); their
real benefits are an auditable decrypt chokepoint — which §8.4 delivers on its
own — and cryptographic erasure, which requires *stored* destroyable DEKs and
therefore N unwraps per bulk grant, on precisely the campaign and export paths
that carry the highest volume. Derived DEKs would be cheap but cannot be
destroyed, forfeiting the only benefit that justified them.

Decision: grant model on a single KMS-held KEK. Erasure is handled by row
deletion plus backup expiry. The `v1:` blob prefix already in `pii_crypto`
leaves envelope encryption addable later without a format break. Revisit if
legal establishes that erasure must reach immutable backups.

The **blind-index pepper is necessarily system-wide** — shared determinism is
what makes refs comparable for uniqueness and lookup — and must be a separate
secret in a separate blast radius from the KEK. Rotating it invalidates every
ref and requires a rebuild; that story is decided up front, not during an
incident.

---

## 9. What this design does not decide

Recorded in the companion product note:

1. Whether an account may be a **legal entity** distinct from the humans acting
   for it. The model holds either way; the organization-custodian half of §5
   depends on the answer.
2. Whether a profile custodied by an org **survives** its subject's erasure
   under the custodian's own lawful basis, or dies with them (§5, §8).
3. Cold-path **disambiguation policy** when §6 resolution returns N candidates.
4. Third-party **notice obligations** for delegate contact fields such as
   `hiringManagerPhoneNumber`, collected today from the account holder with no
   notice to the data principal.
5. Whether R11's one-type-per-subject restriction is retained, and at what
   values the §7 limits are set.

---

## 10. Decomposition

Each becomes its own spec and plan. Ordered so that everything landing first
holds under either answer to §9.1.

| # | Sub-project | Depends on |
|---|---|---|
| P1 | Delete the sniffer; single declared `contacts` block; require anchors to be supplied explicitly (an upload lacking one **fails** rather than guessing) | — |
| P2 | `profile_origin` + profile `tags`; re-key tenancy off `user.onboardedByOrgId` | — |
| P3 | Account PII: KMS KEK, anchors as refs, U18 gate, drop deprecated columns | — |
| P4 | Purpose-bound decrypt grants + unified reveal audit | P2 |
| P5 | Contact points as first-class; inbound N-candidate resolution | P1, P3 |
| P6 | Custodian/subject split; unclaimed profiles; claim flow | P2, P5, §9.1 |
| P7 | Voice session grants (warm context handle + cold path) | P5, P6 |
| P8 | `profile_location` projection; generated facet indexes | — |
| P9 | Configurable limits and subject domain policy | P6 |

Note the ordering constraint between P1 and P6: banning derivation means an
upload with no anchor has nowhere to go, so P1 rejects it. The **unclaimed**
profile — the better answer, and the one §6 rule 2 and §6.1 assume — only becomes available
with P6, which is when uploads lacking an anchor start succeeding again under an
organization custodian. P1 is still worth landing first: rejecting an ambiguous
upload is strictly safer than silently merging two companies under one login.

P6 rewrites `items.created_by NOT NULL REFERENCES "user"(id)` — the most
load-bearing constraint in the schema, and the reason it is sequenced late
rather than first. Migration strategy is out of scope here by intent: the model
is specified on requirements, and the path to it is planned per sub-project.
